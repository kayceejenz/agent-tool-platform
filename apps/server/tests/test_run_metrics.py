from uuid import uuid4

import pytest
from integrations.sandbox.tools import tool_definitions
from modules.benchmarks.helpers.scoring import score_steps
from modules.evaluations.repos.run_metrics_repo import question_key
from psycopg.types.json import Jsonb
from test_executions_integration import ready
from test_mcp_connections_integration import query

pytest_plugins = ["test_mcp_connections_integration"]


def test_steps_partial_credit_duplicates_and_tool_identity():
    expected = [
        {"tool_key": "read", "arguments": {"path": "a", "max_bytes": 512}},
        {"tool_key": "python", "arguments": {"code": "print(1)"}},
        {"tool_key": "list", "arguments": {}},
    ]
    result = score_steps(
        expected,
        [
            {"tool_key": "read", "inputs": {"path": "a", "max_bytes": 256}},
            {"tool_key": "python", "inputs": {"code": "print(2)"}},
            {"tool_key": "unknown", "inputs": {}},
            {"tool_key": "read", "inputs": {"path": "a", "max_bytes": 512}},
        ],
    )
    assert result["precision"] == 50
    assert result["recall"] == 200 / 3
    assert result["argument_accuracy"] == 50
    assert result["matched_calls"] == 2
    assert score_steps(expected, [])["recall"] == 0
    assert score_steps(expected, [])["argument_accuracy"] is None
    assert (
        score_steps(
            [
                {
                    "tool_key": "read",
                    "arguments": {"path": "a", "max_bytes": 512},
                    "input_schema": {"properties": {"max_bytes": {"default": 512}}},
                }
            ],
            [{"tool_key": "read", "inputs": {"path": "a"}}],
        )["argument_accuracy"]
        == 100
    )


def test_question_reference_uses_dataset_contents_not_agent():
    dataset = {
        "id": "dataset",
        "files": [{"id": "one", "name": "a.csv", "sha256": "hash"}],
    }
    first = {
        "input": "Count rows",
        "snapshot": {
            "analysis": {"dataset": dataset},
            "model_settings": {"model": "a"},
        },
    }
    second = {
        "input": "Count rows",
        "snapshot": {
            "analysis": {"dataset": dataset},
            "model_settings": {"model": "b"},
        },
    }
    assert question_key(first) == question_key(second)
    assert question_key(first) != question_key(second | {"input": "Sum rows"})
    changed = {
        **dataset,
        "files": [{"id": "one", "name": "a.csv", "sha256": "changed"}],
    }
    assert question_key(first) != question_key(
        {"input": "Count rows", "snapshot": {"analysis": {"dataset": changed}}}
    )


@pytest.mark.integration
def test_metrics_reference_reuse_access_validation_and_no_judge(
    connections, monkeypatch
):
    client, config, users, project, _agent, _tool, start_url = ready(
        connections, monkeypatch
    )
    owner, _, viewer, outsider = [u[1] for u in users]
    repo = client.app.state.executions
    dataset = {
        "id": str(uuid4()),
        "files": [{"id": str(uuid4()), "name": "a.csv", "sha256": "a" * 64}],
    }

    def start(question="Count rows"):
        response = client.post(
            start_url,
            headers=owner,
            json={
                "revision": 1,
                "input": question,
                "request_id": str(uuid4()),
                "llm_evaluation": False,
            },
        )
        assert response.status_code == 202, response.text
        return response.json()["id"]

    def finish(run_id, with_calls=False):
        async def process():
            run = await repo.claim()
            assert str(run["id"]) == run_id
            if with_calls:
                for name, inputs in [
                    ("read_file", {"path": "/input/a.csv", "max_bytes": 256}),
                    ("execute_python", {"code": "print(2)"}),
                ]:
                    span = await repo.begin_span(
                        run["id"],
                        kind="tool",
                        name="Workspace / " + name,
                        inputs=inputs,
                    )
                    await repo.end_span(span, "success", {"text": "fixture"})
            await repo.finish(run["id"], "completed", "final_answer", "Done")

        client.portal.call(process)
        query(
            config,
            "UPDATE agent_platform.agent_executions SET snapshot=snapshot||%s WHERE id=%s",
            (
                Jsonb(
                    {
                        "analysis": {"dataset": dataset},
                        "builtin_tools": tool_definitions(),
                    }
                ),
                run_id,
            ),
        )

    first = start()
    url = f"/api/v1/projects/{project}/executions/{first}/metrics"
    assert client.get(url, headers=owner).json()["state"] == "pending"
    assert (
        client.post(
            url,
            headers=owner,
            json={"steps": [{"tool_key": "workspace_list_files", "arguments": {}}]},
        ).status_code
        == 409
    )
    finish(first, True)
    assert client.get(url, headers=viewer).json()["state"] == "needs_reference"
    assert client.get(url, headers=outsider).status_code == 404
    steps = {
        "steps": [
            {
                "tool_key": "workspace_read_file",
                "arguments": {"path": "/input/a.csv", "max_bytes": 512},
            },
            {"tool_key": "workspace_execute_python", "arguments": {"code": "print(1)"}},
            {"tool_key": "workspace_list_files", "arguments": {}},
        ]
    }
    assert client.post(url, headers=viewer, json=steps).status_code == 403
    assert client.post(url, headers=outsider, json=steps).status_code == 404
    assert (
        client.post(
            url,
            headers=owner,
            json={"steps": [{"tool_key": "unknown", "arguments": {}}]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            url,
            headers=owner,
            json={"steps": [{"tool_key": "workspace_execute_python", "arguments": {}}]},
        ).status_code
        == 422
    )
    saved = client.post(url, headers=owner, json=steps)
    assert saved.status_code == 200, saved.text
    assert saved.json()["metrics"]["recall"] == 200 / 3
    assert saved.json()["metrics"]["argument_accuracy"] == 25
    assert saved.json()["metrics"]["precision"] == 100
    assert saved.json()["latency_ms"] >= 0
    second = start()
    finish(second)
    second_url = f"/api/v1/projects/{project}/executions/{second}/metrics"
    reused = client.get(second_url, headers=viewer).json()
    assert reused["expected_steps"] == saved.json()["expected_steps"]
    assert reused["metrics"]["recall"] == 0
    assert reused["metrics"]["precision"] is None
    changed = {"steps": [{"tool_key": "workspace_list_files", "arguments": {}}]}
    assert client.post(second_url, headers=owner, json=changed).status_code == 200
    assert len(client.get(url, headers=viewer).json()["expected_steps"]) == 1
    dataset["files"][0]["sha256"] = "b" * 64
    third = start()
    finish(third)
    assert (
        client.get(
            f"/api/v1/projects/{project}/executions/{third}/metrics", headers=viewer
        ).json()["state"]
        == "needs_reference"
    )
    assert (
        query(
            config,
            "SELECT count(*) FROM agent_platform.execution_evaluations WHERE execution_id IN (%s,%s,%s)",
            (first, second, third),
        )[0][0]
        == 0
    )
    snapshot = query(
        config,
        "SELECT snapshot FROM agent_platform.agent_executions WHERE id=%s",
        (first,),
    )[0][0]
    assert not snapshot["evaluation_profile"]["enabled"]
    assert "expected_steps" not in snapshot


def test_benchmark_and_run_metrics_use_the_stored_default_schema():
    import asyncio

    from modules.benchmarks.repos.benchmark_repo import BenchmarkRepository

    class Result:
        async def fetchall(self):
            return [
                {"tool_id": "products", "inputs": {"limit": 5}, "status": "success"}
            ]

        async def fetchone(self):
            return {
                "definition": {
                    "input_schema": {"properties": {"in_stock": {"default": True}}}
                }
            }

    class Database:
        async def execute(self, *args):
            return Result()

    row = {
        "execution_id": "run",
        "status": "completed",
        "tool_id": "products",
        "tool_revision": 1,
        "arguments": {"limit": 5, "in_stock": True},
    }
    asyncio.run(BenchmarkRepository.add_score(Database(), row))
    assert row["score"]["argument_accuracy"] == 100


def test_repeated_tool_calls_use_best_assignment_independent_of_order():
    expected = [
        {"tool_key": "read", "arguments": {"x": 0, "y": 0}},
        {"tool_key": "read", "arguments": {"x": 1, "y": 1}},
    ]
    calls = [
        {"tool_key": "read", "inputs": {"x": 0, "y": 1}},
        {"tool_key": "read", "inputs": {"x": 2, "y": 0}},
    ]
    for steps in [expected, expected[::-1]]:
        for actual in [calls, calls[::-1]]:
            result = score_steps(steps, actual)
            assert result["argument_accuracy"] == 50
            assert result["precision"] == 100
            assert result["recall"] == 100


def test_assignment_agrees_with_exhaustive_small_cases():
    from itertools import permutations
    from random import Random

    from modules.benchmarks.helpers.scoring import _maximum_argument_agreement

    random = Random(7)
    for n, m in [(1, 3), (2, 4), (3, 3), (4, 2)]:
        matrix = [
            [random.choice([0, 25, 50, 75, 100]) for _ in range(m)] for _ in range(n)
        ]
        rows = matrix if n <= m else [list(column) for column in zip(*matrix)]
        expected = max(
            sum(rows[i][j] for i, j in enumerate(columns))
            for columns in permutations(range(len(rows[0])), len(rows))
        )
        assert _maximum_argument_agreement(matrix) == expected
