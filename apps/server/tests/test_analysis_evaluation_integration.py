import asyncio
import json
from uuid import uuid4

import pytest

from modules.datasets.repos.dataset_repo import DatasetRepository
from test_executions_integration import ready
from test_mcp_connections_integration import query

pytest_plugins = ["test_mcp_connections_integration"]
pytestmark = pytest.mark.integration


def setup(connections, monkeypatch):
    client, config, users, project, agent, _tool, _start_url = ready(
        connections, monkeypatch
    )
    agent = agent["id"]
    dataset_id = uuid4()

    async def read(*args):
        return {
            "id": str(dataset_id),
            "name": "Synthetic trial",
            "files": [{"id": str(uuid4()), "name": "events.csv", "sha256": "a" * 64}],
        }

    async def identity(*args):
        return "sha256:" + "a" * 64

    monkeypatch.setattr(DatasetRepository, "read", read)
    monkeypatch.setattr(
        "modules.executions.repos.execution_repo.image_identity", identity
    )
    path = f"/api/v1/projects/{project}/agents/{agent}/analysis-evaluations"
    body = {
        "request_id": str(uuid4()),
        "revision": 1,
        "dataset_id": str(dataset_id),
        "attempts": 5,
        "suite": {
            "name": "Trial",
            "cases": [
                {
                    "id": "PIG-001",
                    "question": "Count rows",
                    "expected": {"rows": 987654321},
                    "comparison": {"rows": {"type": "exact"}},
                }
            ],
        },
    }
    return client, config, users, project, agent, path, body


def test_batch_restarts_repeats_private_references_and_readable_results(
    connections, monkeypatch
):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    headers = users[0][1]
    start = client.post(path, headers=headers, json=body)
    assert start.status_code == 202, start.text
    bid = start.json()["id"]
    assert client.post(path, headers=headers, json=body).json()["id"] == bid
    changed = {**body, "attempts": 1}
    assert client.post(path, headers=headers, json=changed).status_code == 409
    assert (
        client.post(
            path, headers=users[2][1], json={**body, "request_id": str(uuid4())}
        ).status_code
        == 403
    )
    assert client.get(path + "/" + bid, headers=users[3][1]).status_code == 404
    records = query(
        config, "SELECT input,snapshot FROM agent_platform.agent_executions"
    )
    for text, snapshot in records:
        assert "987654321" not in text and "987654321" not in json.dumps(snapshot)
    repo = client.app.state.executions
    batches = client.app.state.analysis_evaluations

    async def execute_all():
        for i in range(5):
            # Repeated advancement never dispatches a duplicate while one is active.
            await batches.advance()
            await batches.advance()
            run = await repo.claim()
            assert run is not None
            await repo.finish(
                run["id"],
                "completed",
                "final_answer",
                json.dumps(
                    {
                        "final_answer": "A readable result.",
                        "answers": {"rows": 987654321 if i < 4 else 0},
                    }
                ),
            )
        await batches.advance()

    asyncio.run(execute_all())
    detail = client.get(path + "/" + bid, headers=headers)
    assert detail.status_code == 200, detail.text
    value = detail.json()
    assert value["status"] == "completed"
    assert len({a["execution_id"] for a in value["attempts"]}) == 5
    assert value["summary"]["answer_correctness"] == 80
    assert value["summary"]["pass_k"] == {"1": 80, "5": 0}
    assert (
        value["attempts"][0]["result"]["parsed"]["final_answer"] == "A readable result."
    )
    assert len(client.get(path, headers=users[2][1]).json()["items"]) == 1


def test_cancel_keeps_results_and_stops_unscheduled_attempts(connections, monkeypatch):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    bid = client.post(path, headers=users[0][1], json=body).json()["id"]
    assert (
        client.post(
            path + "/" + bid + "/cancel", headers=users[2][1], json={}
        ).status_code
        == 403
    )
    assert (
        client.post(
            path + "/" + bid + "/cancel", headers=users[0][1], json={}
        ).status_code
        == 200
    )
    asyncio.run(client.app.state.analysis_evaluations.advance())
    detail = client.get(path + "/" + bid, headers=users[0][1]).json()
    assert detail["status"] == "cancelled"
    assert detail["summary"]["finished"] == 5
    assert detail["summary"]["pass_k"] is None
    assert sum(a["execution_id"] is not None for a in detail["attempts"]) == 1


def test_invalid_suites_and_answer_keys_do_not_leave_orphan_executions(
    connections, monkeypatch
):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    invalid = json.loads(json.dumps(body))
    invalid["suite"]["cases"].append(invalid["suite"]["cases"][0])
    assert client.post(path, headers=users[0][1], json=invalid).status_code == 422

    async def hidden(*args):
        return {
            "id": body["dataset_id"],
            "name": "Unsafe dataset",
            "files": [
                {
                    "id": str(uuid4()),
                    "name": "ANSWER_KEY_ground_truth.csv",
                    "sha256": "a" * 64,
                }
            ],
        }

    monkeypatch.setattr(DatasetRepository, "read", hidden)
    assert client.post(path, headers=users[0][1], json=body).status_code == 422
    assert (
        query(config, "SELECT count(*) FROM agent_platform.agent_executions")[0][0] == 0
    )
    assert (
        query(
            config, "SELECT count(*) FROM agent_platform.analysis_evaluation_batches"
        )[0][0]
        == 0
    )


def test_multiple_questions_use_the_normal_runtime_and_preserve_unstructured_answers(
    connections, monkeypatch
):
    from integrations.agents.langchain_runtime import LangChainRuntime
    from langchain_core.messages import AIMessage
    from test_agent_runtime import ScriptedModel

    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    body["attempts"] = 1
    body["suite"]["cases"].append(
        {
            "id": "SECOND",
            "question": "Another count",
            "expected": {"n": 2},
            "comparison": {"n": {"type": "exact"}},
        }
    )
    bid = client.post(path, headers=users[0][1], json=body).json()["id"]
    repo, batches = client.app.state.executions, client.app.state.analysis_evaluations

    async def prepare_stub(self):
        pass

    monkeypatch.setattr(
        "integrations.sandbox.tools.WorkspaceTools.prepare", prepare_stub
    )

    async def process():
        for answer in [
            json.dumps(
                {
                    "final_answer": "Readable first answer.",
                    "answers": {"rows": 987654321},
                }
            ),
            "Unstructured second answer: 2.",
        ]:
            # Simulate multiple workers ticking at the same time after a restart.
            await asyncio.gather(batches.advance(), batches.advance())
            run = await repo.claim()
            model = ScriptedModel(responses=[AIMessage(content=answer)])
            runtime = LangChainRuntime(
                repo, client.app.state.tools, config, lambda _: model
            )
            # No file tool call is requested, so this exercises the actual model turn without Docker.
            await runtime.execute(run)
        await batches.advance()

    asyncio.run(process())
    result = client.get(path + "/" + bid, headers=users[0][1]).json()
    assert result["status"] == "completed"
    assert result["summary"]["task_success_rate"] == 50
    assert (
        result["attempts"][0]["result"]["parsed"]["final_answer"]
        == "Readable first answer."
    )
    assert result["attempts"][1]["raw_answer"] == "Unstructured second answer: 2."
    assert result["attempts"][1]["result"]["error"] == "invalid_answer_format"


def test_changed_agent_never_silently_switches_revision(connections, monkeypatch):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    bid = client.post(path, headers=users[0][1], json=body).json()["id"]
    query(
        config, "UPDATE agent_platform.agents SET enabled=false WHERE id=%s", (agent,)
    )
    repo, batches = client.app.state.executions, client.app.state.analysis_evaluations

    async def process():
        run = await repo.claim()
        await repo.finish(run["id"], "failed", "access_revoked", None)
        await batches.advance()
        await batches.advance()

    asyncio.run(process())
    result = client.get(path + "/" + bid, headers=users[0][1]).json()
    assert result["status"] == "completed"
    assert result["summary"]["task_success_rate"] == 0
    assert len([a for a in result["attempts"] if a["execution_id"]]) == 1
    assert result["attempts"][1]["result"]["error"] == "access_or_configuration_changed"


def test_playground_reference_uses_task_input_and_stays_private(
    connections, monkeypatch
):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    run_path = f"/api/v1/projects/{project}/agents/{agent}/executions"
    payload = {
        "revision": 1,
        "request_id": str(uuid4()),
        "input": "Count feeding bouts",
        "analysis": {"dataset_id": body["dataset_id"]},
        "answer_reference": {
            "expected": {"feeding_bouts": 27532},
            "comparison": {"feeding_bouts": {"type": "exact"}},
        },
    }
    started = client.post(run_path, headers=users[0][1], json=payload)
    assert started.status_code == 202, started.text
    run_id = started.json()["id"]
    assert (
        client.post(run_path, headers=users[0][1], json=payload).json()["id"] == run_id
    )
    row = query(
        config,
        "SELECT input,snapshot FROM agent_platform.agent_executions WHERE id=%s",
        (run_id,),
    )[0]
    assert row[0].startswith("Count feeding bouts")
    assert "27532" not in row[0] and "27532" not in json.dumps(row[1])
    endpoint = f"/api/v1/projects/{project}/executions/{run_id}/answer-evaluation"
    assert (
        client.get(endpoint, headers=users[0][1]).json()["evaluation"]["state"]
        == "pending"
    )
    assert client.get(endpoint, headers=users[3][1]).status_code == 404

    async def process():
        repo = client.app.state.executions
        run = await repo.claim()
        await repo.finish(
            run["id"],
            "completed",
            "final_answer",
            json.dumps(
                {
                    "final_answer": "There are 27532 feeding bouts.",
                    "answers": {"feeding_bouts": 27532},
                }
            ),
        )
        await client.app.state.analysis_evaluations.advance()

    asyncio.run(process())
    evaluation = client.get(endpoint, headers=users[2][1]).json()["evaluation"]
    assert evaluation["state"] == "scored"
    assert evaluation["question"] == "Count feeding bouts"
    displayed = client.get(
        f"/api/v1/projects/{project}/executions/{run_id}?view=summary",
        headers=users[0][1],
    ).json()
    assert displayed["input"] == "Count feeding bouts"
    assert evaluation["result"]["success"]
    assert (
        evaluation["result"]["parsed"]["final_answer"]
        == "There are 27532 feeding bouts."
    )
    assert (
        client.post(
            run_path,
            headers=users[0][1],
            json={**payload, "request_id": str(uuid4()), "analysis": None},
        ).status_code
        == 422
    )


def test_required_tools_are_scored_from_trace_not_model_claims(
    connections, monkeypatch
):
    client, config, users, project, agent, path, body = setup(connections, monkeypatch)
    run_path = f"/api/v1/projects/{project}/agents/{agent}/executions"
    payload = {
        "revision": 1,
        "request_id": str(uuid4()),
        "input": "Count rows",
        "analysis": {"dataset_id": body["dataset_id"]},
        "answer_reference": {
            "expected": {"rows": 42},
            "comparison": {"rows": {"type": "exact"}},
            "required_tools": ["read_file", "execute_python"],
        },
    }
    response = client.post(run_path, headers=users[0][1], json=payload)
    assert response.status_code == 202, response.text
    run_id = response.json()["id"]
    stored = query(
        config,
        "SELECT input,snapshot FROM agent_platform.agent_executions WHERE id=%s",
        (run_id,),
    )[0]
    assert "required_tools" not in stored[0] and "required_tools" not in json.dumps(
        stored[1]
    )

    async def process():
        repo = client.app.state.executions
        run = await repo.claim()
        for name, status in [
            ("read_file", "error"),
            ("execute_python", "success"),
            ("execute_python", "success"),
        ]:
            span = await repo.begin_span(
                run["id"], kind="tool", name="Workspace / " + name, inputs={}
            )
            await repo.end_span(span, status, {"text": "fixture"})
        await repo.finish(
            run["id"],
            "completed",
            "final_answer",
            json.dumps(
                {
                    "final_answer": "I used list_files. There are 42 rows.",
                    "answers": {"rows": 42},
                }
            ),
        )
        await client.app.state.analysis_evaluations.advance()

    asyncio.run(process())
    detail = client.get(
        f"/api/v1/projects/{project}/executions/{run_id}/answer-evaluation",
        headers=users[0][1],
    ).json()["evaluation"]
    selection = detail["result"]["tool_selection"]
    assert selection["accuracy"] == 100
    assert selection["used"] == ["execute_python", "read_file"]
    assert selection["missing"] == selection["unexpected"] == []
    assert detail["result"]["success"]
