"""Deterministic tool-use evaluation; no provider calls or task execution."""

import hashlib
import json

from jsonschema import Draft202012Validator
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from modules.agents.models.error_model import AgentError
from modules.agents.repos.agent_repo import AgentRepository
from modules.benchmarks.helpers.scoring import score_steps


def question_key(run):
    dataset = run["snapshot"].get("analysis", {}).get("dataset")
    contents = (
        None
        if not dataset
        else {
            "id": str(dataset["id"]),
            "files": sorted(
                (str(f["id"]), f["name"], f["sha256"]) for f in dataset["files"]
            ),
        }
    )
    return hashlib.sha256(
        json.dumps([run["input"], contents], sort_keys=True).encode()
    ).hexdigest()


def available_tools(run):
    return [
        {
            "tool_key": str(tool.get("id") or tool["alias"]),
            "name": tool["server_name"] + " / " + tool["name"],
            "input_schema": tool["definition"]["input_schema"],
        }
        for tool in [
            *run["snapshot"]["tools"],
            *run["snapshot"].get("builtin_tools", []),
        ]
    ]


class RunMetricsRepository:
    def __init__(self, database):
        self.database = database

    @staticmethod
    async def execution(db, project_id, execution_id):
        row = await (
            await db.execute(
                "SELECT id,input,status,benchmark_id,snapshot,started_at,finished_at FROM agent_platform.agent_executions WHERE id=%s AND project_id=%s",
                (execution_id, project_id),
            )
        ).fetchone()
        if not row:
            raise AgentError(404, "Execution not found")
        return row

    async def save(self, user_id, project_id, execution_id, body):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id, True)
            run = await self.execution(db, project_id, execution_id)
            if run["benchmark_id"]:
                raise AgentError(
                    409, "This run already uses a saved benchmark reference"
                )
            if run["status"] in ("queued", "running"):
                raise AgentError(
                    409, "Wait for the run to finish before defining expected steps"
                )
            tools = {tool["tool_key"]: tool for tool in available_tools(run)}
            steps = []
            for step in body.steps:
                tool = tools.get(step.tool_key)
                if not tool:
                    raise AgentError(422, "Choose a tool available in this run")
                if not Draft202012Validator(tool["input_schema"]).is_valid(
                    step.arguments
                ):
                    raise AgentError(
                        422,
                        "Expected arguments do not match the selected tool schema",
                    )
                steps.append({**tool, "arguments": step.arguments})
            await db.execute(
                """INSERT INTO agent_platform.execution_metric_references(project_id,question_key,calls,updated_by)
                   VALUES (%s,%s,%s,%s) ON CONFLICT(project_id,question_key)
                   DO UPDATE SET calls=EXCLUDED.calls,updated_by=EXCLUDED.updated_by,updated_at=now()""",
                (project_id, question_key(run), Jsonb(steps), user_id),
            )
        return await self.get(user_id, project_id, execution_id)

    async def get(self, user_id, project_id, execution_id):
        async with (
            self.database.connection() as conn,
            conn.cursor(row_factory=dict_row) as db,
        ):
            await AgentRepository.member(db, user_id, project_id)
            run = await self.execution(db, project_id, execution_id)
            tools = available_tools(run)
            source = "question"
            expected = None
            if run["benchmark_id"]:
                reference = await (
                    await db.execute(
                        "SELECT b.*,r.definition FROM agent_platform.tool_benchmarks b JOIN agent_platform.tool_revisions r ON r.tool_id=b.tool_id AND r.revision=b.tool_revision WHERE b.id=%s AND b.project_id=%s",
                        (run["benchmark_id"], project_id),
                    )
                ).fetchone()
                if reference:
                    source = "benchmark"
                    expected = [
                        {
                            "tool_key": str(reference["tool_id"]),
                            "name": reference["server_name"]
                            + " / "
                            + reference["tool_name"],
                            "arguments": reference["arguments"],
                            "input_schema": reference["definition"]["input_schema"],
                        }
                    ]
            else:
                reference = await (
                    await db.execute(
                        "SELECT calls FROM agent_platform.execution_metric_references WHERE project_id=%s AND question_key=%s",
                        (project_id, question_key(run)),
                    )
                ).fetchone()
                if reference:
                    expected = reference["calls"]
            spans = await (
                await db.execute(
                    "SELECT name,tool_id,inputs,status FROM agent_platform.execution_spans WHERE execution_id=%s AND kind='tool' ORDER BY sequence",
                    (execution_id,),
                )
            ).fetchall()
            by_name = {tool["name"]: tool["tool_key"] for tool in tools}
            calls = [
                {
                    "tool_key": str(span["tool_id"])
                    if span["tool_id"]
                    else by_name.get(span["name"], "unknown:" + span["name"]),
                    "inputs": span["inputs"],
                }
                for span in spans
            ]
            pending = run["status"] in ("queued", "running")
            latency = None
            if run["started_at"] and run["finished_at"]:
                latency = max(
                    0,
                    (run["finished_at"] - run["started_at"]).total_seconds() * 1000,
                )
            return {
                "state": "pending"
                if pending
                else "scored"
                if expected
                else "needs_reference",
                "source": source,
                "tools": tools,
                "expected_steps": expected,
                "metrics": score_steps(expected, calls)
                if expected and not pending
                else None,
                "latency_ms": latency,
            }
