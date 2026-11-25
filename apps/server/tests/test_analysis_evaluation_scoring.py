import json

import pytest
from modules.analysis_evaluations.dtos.suite_dto import StartBatch, Suite
from modules.analysis_evaluations.helpers.scoring import (
    execution_prompt,
    parse_answer,
    score,
    summary,
)
from pydantic import ValidationError


def case(expected=None, rule=None):
    return {
        "id": "COUNT",
        "question": "Count rows",
        "expected": expected or {"rows": 42},
        "comparison": rule if rule is not None else {"rows": {"type": "exact"}},
    }


def response(values, text="There are 42 rows."):
    return json.dumps({"final_answer": text, "answers": values})


def test_reference_values_never_appear_in_prompt():
    prompt = execution_prompt(case({"rows": 987654321}))
    assert "987654321" not in prompt
    assert "rows" in prompt and "number" in prompt and "final_answer" in prompt


def test_readable_answer_and_raw_structured_values_are_preserved():
    result = score(case(), response({"rows": 42}), "completed")
    assert result["success"]
    assert result["parsed"]["final_answer"] == "There are 42 rows."
    assert result["parsed"]["answers"] == {"rows": 42}
    assert not score(case(), response({"rows": 41}), "completed")["success"]


@pytest.mark.parametrize(
    "raw",
    [
        "42",
        '{"answers":{"rows":42}}',
        '{"final_answer":"ok","answers":{"rows":42,"rows":41}}',
        '{"final_answer":"ok","answers":{"rows":NaN}}',
        '{"final_answer":"ok","answers":{"rows":1e999}}',
        "Here is my answer: 42",
    ],
)
def test_invalid_output_is_not_repaired_or_guessed(raw):
    result = score(case(), raw, "completed")
    assert result["error"] == "invalid_answer_format"
    assert not result["success"]
    assert not result["fields"]["rows"]["correct"]


def test_missing_zero_bool_string_and_failed_runs():
    assert not score(case(), response({}), "completed")["success"]
    assert not score(case(), response({"rows": "42"}), "completed")["success"]
    assert not score(case({"rows": 1}), response({"rows": True}), "completed")[
        "success"
    ]
    assert not score(case(), response({"rows": 42}), "failed")["fields"]["rows"][
        "correct"
    ]
    assert score(case({"rows": 0}), response({"rows": 0}), "completed")["success"]


def test_tolerance_and_json_exact_semantics():
    c = case(
        {"rows": 42.0},
        {"rows": {"type": "numeric_tolerance", "absolute_tolerance": 0.01}},
    )
    assert score(c, response({"rows": 42.005}), "completed")["success"]
    assert not score(c, response({"rows": 42.02}), "completed")["success"]
    c = case({"values": [1, 2]}, {"values": {"type": "exact"}})
    assert not score(c, response({"values": [2, 1]}), "completed")["success"]


def test_json_fence_is_supported_without_extra_prose():
    assert (
        parse_answer("```json\n" + response({"rows": 42}) + "\n```")["answers"]["rows"]
        == 42
    )


def test_suite_validation_rejects_ambiguous_references():
    for cases in [
        [case(), case()],
        [case(rule={})],
        [case({"rows": "42"}, {"rows": {"type": "numeric_tolerance"}})],
    ]:
        with pytest.raises(ValidationError):
            Suite.model_validate({"name": "Test", "cases": cases})


def test_reliability_is_all_successes_and_summary_waits_for_completion():
    attempts = [
        {
            "case_id": "COUNT",
            "result": score(
                case(), response({"rows": 42 if i < 4 else 40}), "completed"
            ),
            "latency_ms": 1000 * (i + 1),
        }
        for i in range(5)
    ]
    result = summary(attempts, 5, True)
    assert result["answer_correctness"] == result["task_success_rate"] == 80
    assert result["pass_k"] == {"1": 80, "5": 0}
    assert result["median_latency_ms"] == 3000 and result["p95_latency_ms"] == 5000
    assert summary(attempts, 5, False)["pass_k"] is None


def test_partial_credit_missing_latency_and_case_level_success():
    c = case({"a": 1, "b": 2}, {"a": {"type": "exact"}, "b": {"type": "exact"}})
    attempts = [
        {
            "case_id": "COUNT",
            "result": score(c, response({"a": 1}), "completed"),
            "latency_ms": None,
        }
    ]
    result = summary(attempts, 1, True)
    assert result["answer_correctness"] == 50
    assert result["task_success_rate"] == 0
    assert result["median_latency_ms"] is None and result["timed_attempts"] == 0


def test_tool_selection_uses_distinct_actual_calls_and_penalizes_missing_and_extra():
    from modules.analysis_evaluations.helpers.scoring import tool_selection

    required = ["read_file", "execute_python"]
    assert (
        tool_selection(required, ["read_file", "execute_python", "execute_python"])[
            "accuracy"
        ]
        == 100
    )
    missing = tool_selection(required, ["execute_python"])
    assert missing["accuracy"] == 50 and missing["missing"] == ["read_file"]
    extra = tool_selection(required, ["list_files", "read_file", "execute_python"])
    assert extra["accuracy"] == 200 / 3 and extra["unexpected"] == ["list_files"]
    assert tool_selection(required, [])["accuracy"] == 0
    assert tool_selection(None, ["execute_python"]) is None


def test_tool_expectations_stay_private_and_do_not_change_answer_success():
    c = case()
    with_tools = {**c, "required_tools": ["read_file", "execute_python"]}
    assert execution_prompt(c) == execution_prompt(with_tools)
    result = score(with_tools, response({"rows": 42}), "completed", ["execute_python"])
    assert result["success"] and result["tool_selection"]["accuracy"] == 50
    failed = score(with_tools, None, "failed", ["read_file", "execute_python"])
    assert not failed["success"] and failed["tool_selection"]["accuracy"] == 100
    totals = summary([{"case_id": "COUNT", "result": result}], 1, True)
    assert (
        totals["tool_selection_accuracy"] == 50 and totals["tool_scored_attempts"] == 1
    )


def test_required_tools_reject_unsupported_duplicates_and_empty_lists():
    from modules.analysis_evaluations.dtos.suite_dto import AnswerReference

    for tools in [[], ["read_file", "read_file"], ["invented_tool"]]:
        with pytest.raises(ValidationError):
            AnswerReference.model_validate(
                {
                    "expected": {"rows": 42},
                    "comparison": {"rows": {"type": "exact"}},
                    "required_tools": tools,
                }
            )


@pytest.mark.parametrize("attempts", [1, 2, 3, 5, 10, 100])
def test_custom_attempt_count(attempts):
    value = StartBatch.model_validate({
        "request_id": "11111111-1111-4111-8111-111111111111",
        "dataset_id": "22222222-2222-4222-8222-222222222222",
        "revision": 1, "attempts": attempts,
        "suite": {"name": "Test", "cases": [case()]},
    })
    assert value.attempts == attempts


@pytest.mark.parametrize("attempts", [0, -1, 101, 1.5, True, "3"])
def test_invalid_attempt_count(attempts):
    with pytest.raises(ValidationError):
        StartBatch.model_validate({
            "request_id": "11111111-1111-4111-8111-111111111111",
            "dataset_id": "22222222-2222-4222-8222-222222222222",
            "revision": 1, "attempts": attempts,
            "suite": {"name": "Test", "cases": [case()]},
        })
