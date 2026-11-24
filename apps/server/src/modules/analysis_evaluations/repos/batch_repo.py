"""Persisted batch scheduler around ordinary executions, with private references."""

import hashlib
import json
from uuid import uuid4

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from modules.agents.models.error_model import AgentError
from modules.agents.repos.agent_repo import AgentRepository
from modules.analysis_evaluations.helpers.scoring import (
    execution_prompt,
    score,
    summary,
)
from modules.executions.dtos.execution_dto import AnalysisRequest, StartExecution


class AnalysisEvaluationRepository:
    def __init__(self, database, executions):
        self.database, self.executions = database, executions

    async def create(self, user_id, project_id, agent_id, body):
        payload = body.model_dump(mode="json")
        digest = hashlib.sha256(
            json.dumps([str(agent_id), payload], sort_keys=True).encode()
        ).hexdigest()
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id, True)
            # Serialise admission and uncertain-request retries for this project/user.
            await db.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                (f"analysis-eval:{project_id}:{user_id}",),
            )
            old = await (
                await db.execute(
                    "SELECT * FROM agent_platform.analysis_evaluation_batches WHERE project_id=%s AND user_id=%s AND request_id=%s",
                    (project_id, user_id, body.request_id),
                )
            ).fetchone()
            if old:
                if old["request_hash"] != digest:
                    raise AgentError(
                        409, "Request ID already used for a different evaluation"
                    )
                return {"id": old["id"]}
            active = await (
                await db.execute(
                    "SELECT id FROM agent_platform.analysis_evaluation_batches WHERE project_id=%s AND user_id=%s AND status IN ('running','cancelling')",
                    (project_id, user_id),
                )
            ).fetchone()
            if active:
                raise AgentError(409, "Finish or cancel the active evaluation first")
            suite = body.suite.model_dump(mode="json")
            first = suite["cases"][0]
            run = await self.executions.start(
                user_id,
                project_id,
                agent_id,
                StartExecution(
                    revision=body.revision,
                    request_id=uuid4(),
                    analysis=AnalysisRequest(dataset_id=body.dataset_id),
                    llm_evaluation=False,
                    input=execution_prompt(first),
                ),
                connection=conn,
            )
            snapshot = run["snapshot"]
            if any(
                any(
                    label in f["name"].lower()
                    for label in ("answer_key", "ground_truth", "reference_answers")
                )
                for f in snapshot["analysis"]["dataset"]["files"]
            ):
                raise AgentError(
                    422, "Remove evaluator-only answer keys from the selected dataset"
                )
            snapshot["analysis_evaluation"] = {
                "answer_format": "readable-json-v1",
                "question": first["question"],
            }
            await db.execute(
                "UPDATE agent_platform.agent_executions SET snapshot=%s WHERE id=%s",
                (Jsonb(snapshot), run["id"]),
            )
            batch_id = uuid4()
            await db.execute(
                """INSERT INTO agent_platform.analysis_evaluation_batches
                (id,project_id,agent_id,user_id,request_id,request_hash,agent_revision,repetitions,suite,snapshot)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    batch_id,
                    project_id,
                    agent_id,
                    user_id,
                    body.request_id,
                    digest,
                    body.revision,
                    body.attempts,
                    Jsonb(suite),
                    Jsonb(snapshot),
                ),
            )
            for position, case in enumerate(suite["cases"]):
                for attempt in range(1, body.attempts + 1):
                    await db.execute(
                        "INSERT INTO agent_platform.analysis_evaluation_attempts(id,batch_id,case_id,position,attempt,execution_id) VALUES (%s,%s,%s,%s,%s,%s)",
                        (
                            uuid4(),
                            batch_id,
                            case["id"],
                            position,
                            attempt,
                            run["id"] if position == 0 and attempt == 1 else None,
                        ),
                    )
            return {"id": batch_id}

    async def list(self, user_id, project_id, agent_id, offset=0):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id)
            rows = await (
                await db.execute(
                    "SELECT id,suite->>'name' AS name,status,created_at FROM agent_platform.analysis_evaluation_batches WHERE project_id=%s AND agent_id=%s ORDER BY created_at DESC LIMIT 21 OFFSET %s",
                    (project_id, agent_id, offset),
                )
            ).fetchall()
            return {
                "items": rows[:20],
                "next_offset": offset + 20 if len(rows) > 20 else None,
            }

    async def get(self, user_id, project_id, agent_id, batch_id):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id)
            batch = await self.batch(db, project_id, agent_id, batch_id)
            attempts = await self.attempts(db, batch_id)
            # No need to return the entire model/tool snapshot twice to the browser.
            return {
                "id": batch["id"],
                "name": batch["suite"]["name"],
                "status": batch["status"],
                "created_at": batch["created_at"],
                "repetitions": batch["repetitions"],
                "agent_revision": batch["agent_revision"],
                "dataset": batch["snapshot"]["analysis"]["dataset"],
                "suite": batch["suite"],
                "attempts": attempts,
                "summary": summary(
                    attempts, batch["repetitions"], batch["status"] == "completed"
                ),
            }

    @staticmethod
    async def batch(db, project_id, agent_id, batch_id):
        row = await (
            await db.execute(
                "SELECT * FROM agent_platform.analysis_evaluation_batches WHERE id=%s AND project_id=%s AND agent_id=%s",
                (batch_id, project_id, agent_id),
            )
        ).fetchone()
        if not row:
            raise AgentError(404, "Evaluation not found in this project")
        return row

    @staticmethod
    async def attempts(db, batch_id):
        return await (
            await db.execute(
                """SELECT a.*,e.status AS execution_status,e.final_answer AS raw_answer,
            e.termination_reason,CASE WHEN e.started_at IS NOT NULL AND e.finished_at IS NOT NULL
            THEN greatest(0,extract(epoch FROM e.finished_at-e.started_at)*1000)::double precision END AS latency_ms
            FROM agent_platform.analysis_evaluation_attempts a LEFT JOIN agent_platform.agent_executions e ON e.id=a.execution_id
            WHERE a.batch_id=%s ORDER BY a.position,a.attempt""",
                (batch_id,),
            )
        ).fetchall()

    @staticmethod
    async def used_tools(db, execution_id, snapshot):
        # Resolve actual trace names against frozen built-in definitions, never model claims.
        names = {
            f"{t['server_name']} / {t['name']}": t["name"]
            for t in snapshot.get("builtin_tools", [])
        }
        spans = await (
            await db.execute(
                "SELECT name FROM agent_platform.execution_spans WHERE execution_id=%s AND kind='tool'",
                (execution_id,),
            )
        ).fetchall()
        return [names.get(span["name"], "other: " + span["name"]) for span in spans]

    async def for_execution(self, user_id, project_id, execution_id):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id)
            exists = await (
                await db.execute(
                    "SELECT id FROM agent_platform.agent_executions WHERE id=%s AND project_id=%s",
                    (execution_id, project_id),
                )
            ).fetchone()
            if not exists:
                raise AgentError(404, "Execution not found")
            row = await (
                await db.execute(
                    "SELECT b.* FROM agent_platform.analysis_evaluation_batches b JOIN agent_platform.analysis_evaluation_attempts a ON a.batch_id=b.id WHERE a.execution_id=%s AND b.project_id=%s",
                    (execution_id, project_id),
                )
            ).fetchone()
            if not row:
                return {"evaluation": None}
            attempts = await self.attempts(db, row["id"])
            current = next(
                a for a in attempts if str(a["execution_id"]) == str(execution_id)
            )
            case = next(
                c for c in row["suite"]["cases"] if c["id"] == current["case_id"]
            )
            related = [a for a in attempts if a["case_id"] == current["case_id"]]
            return {
                "evaluation": {
                    "state": "scored" if current["result"] is not None else "pending",
                    "expected": case["expected"],
                    "required_tools": case.get("required_tools"),
                    "question": case["question"],
                    "result": current["result"],
                    "latency_ms": current["latency_ms"],
                    "repetitions": row["repetitions"],
                    "summary": summary(
                        related, row["repetitions"], row["status"] == "completed"
                    ),
                }
            }

    async def cancel(self, user_id, project_id, agent_id, batch_id):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id, True)
            await self.batch(db, project_id, agent_id, batch_id)
            await db.execute(
                "UPDATE agent_platform.analysis_evaluation_batches SET status='cancelling',updated_at=now() WHERE id=%s AND status='running'",
                (batch_id,),
            )
            await db.execute(
                """UPDATE agent_platform.agent_executions SET cancel_requested=true,
                status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
                finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
                termination_reason=CASE WHEN status='queued' THEN 'cancelled' ELSE termination_reason END
                WHERE id IN (SELECT execution_id FROM agent_platform.analysis_evaluation_attempts WHERE batch_id=%s)
                AND status IN ('queued','running')""",
                (batch_id,),
            )
            return {"id": batch_id}

    async def advance(self):
        """One locked batch per tick. Safe across workers, restarts and polling retries."""
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            batch = await (
                await db.execute(
                    "SELECT * FROM agent_platform.analysis_evaluation_batches WHERE status IN ('running','cancelling') ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1"
                )
            ).fetchone()
            if not batch:
                return
            cases = {c["id"]: c for c in batch["suite"]["cases"]}
            attempts = await self.attempts(db, batch["id"])
            active = False
            pending = []
            for attempt in attempts:
                if attempt["result"] is not None:
                    continue
                if attempt["execution_status"] in ("queued", "running"):
                    active = True
                elif attempt["execution_id"] is not None:
                    await db.execute(
                        "UPDATE agent_platform.analysis_evaluation_attempts SET result=%s WHERE id=%s",
                        (
                            Jsonb(
                                score(
                                    cases[attempt["case_id"]],
                                    attempt["raw_answer"],
                                    attempt["execution_status"],
                                    await self.used_tools(
                                        db, attempt["execution_id"], batch["snapshot"]
                                    ),
                                )
                            ),
                            attempt["id"],
                        ),
                    )
                else:
                    pending.append(attempt)
            if batch["status"] == "cancelling":
                for attempt in pending:
                    await db.execute(
                        "UPDATE agent_platform.analysis_evaluation_attempts SET result=%s WHERE id=%s",
                        (
                            Jsonb(
                                score(cases[attempt["case_id"]], None, "cancelled", [])
                            ),
                            attempt["id"],
                        ),
                    )
                if not active:
                    await db.execute(
                        "UPDATE agent_platform.analysis_evaluation_batches SET status='cancelled' WHERE id=%s",
                        (batch["id"],),
                    )
            elif not active and pending:
                try:
                    await AgentRepository.member(
                        db, batch["user_id"], batch["project_id"], True
                    )
                    agent = await AgentRepository.agent(
                        db, batch["project_id"], batch["agent_id"]
                    )
                    if (
                        not agent["enabled"]
                        or agent["current_revision"] != batch["agent_revision"]
                    ):
                        raise AgentError(409, "Agent configuration changed")
                except AgentError:
                    # Frozen configurations never silently switch to a new revision.
                    for attempt in pending:
                        result = score(cases[attempt["case_id"]], None, "blocked", [])
                        result["error"] = "access_or_configuration_changed"
                        await db.execute(
                            "UPDATE agent_platform.analysis_evaluation_attempts SET result=%s WHERE id=%s",
                            (Jsonb(result), attempt["id"]),
                        )
                else:
                    attempt = pending[0]
                    text = self.executions.redact_for_storage(
                        execution_prompt(cases[attempt["case_id"]])
                    )
                    execution_id = uuid4()
                    await db.execute(
                        """INSERT INTO agent_platform.agent_executions
                        (id,project_id,agent_id,agent_revision,user_id,request_id,input,input_hash,snapshot)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (
                            execution_id,
                            batch["project_id"],
                            batch["agent_id"],
                            batch["agent_revision"],
                            batch["user_id"],
                            uuid4(),
                            text,
                            hashlib.sha256(text.encode()).hexdigest(),
                            Jsonb(
                                {
                                    **batch["snapshot"],
                                    "analysis_evaluation": {
                                        "answer_format": "readable-json-v1",
                                        "question": cases[attempt["case_id"]][
                                            "question"
                                        ],
                                    },
                                }
                            ),
                        ),
                    )
                    await db.execute(
                        "UPDATE agent_platform.analysis_evaluation_attempts SET execution_id=%s WHERE id=%s",
                        (execution_id, attempt["id"]),
                    )
            elif not active:
                await db.execute(
                    "UPDATE agent_platform.analysis_evaluation_batches SET status='completed' WHERE id=%s",
                    (batch["id"],),
                )
            await db.execute(
                "UPDATE agent_platform.analysis_evaluation_batches SET updated_at=now() WHERE id=%s",
                (batch["id"],),
            )
