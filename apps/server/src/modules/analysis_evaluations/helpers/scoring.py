"""Deterministic scoring, never a model judge or answer-repair operation."""

import json
import math

SCORING_VERSION = "analysis-v2"


def answer_type(value):
    return {
        str: "string",
        bool: "boolean",
        int: "number",
        float: "number",
        list: "array",
        dict: "object",
        type(None): "null",
    }[type(value)]


def execution_prompt(case):
    # Only field names and types are public. No reference values or tolerances.
    fields = {key: answer_type(value) for key, value in case["expected"].items()}
    return (
        case["question"] + "\n\nReturn one JSON object with exactly two keys: "
        "final_answer (a readable explanation for the user) and answers (an object "
        "containing the following fields and JSON types): "
        + json.dumps(fields)
        + ". Compute the answer from the selected dataset. The explanation and structured "
        "values must agree. Do not include markdown fences or additional text."
    )


def reject_constant(value):
    raise ValueError("Non-finite number")


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def parse_answer(raw):
    text = (raw or "").strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    elif text.startswith("```\n") and text.endswith("```"):
        text = text[4:-3].strip()
    data = json.loads(
        text, parse_constant=reject_constant, object_pairs_hook=unique_keys
    )
    if (
        not isinstance(data, dict)
        or set(data) != {"final_answer", "answers"}
        or not isinstance(data["final_answer"], str)
        or not data["final_answer"].strip()
        or not isinstance(data["answers"], dict)
    ):
        raise ValueError("Expected final_answer text and answers object")
    # Reject exponent overflow (JSON 1e999 is parsed as infinity by Python).
    json.dumps(data, allow_nan=False)
    return data


def exact(expected, actual):
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return expected == actual
    if type(expected) is not type(actual):
        return False
    if isinstance(expected, dict):
        return expected.keys() == actual.keys() and all(
            exact(v, actual[k]) for k, v in expected.items()
        )
    if isinstance(expected, list):
        return len(expected) == len(actual) and all(
            exact(a, b) for a, b in zip(expected, actual)
        )
    return expected == actual


def tool_selection(required, used):
    """Set agreement, not execution health. Extra and missing tools both reduce it."""
    if required is None or used is None:
        return None
    expected, actual = set(required), set(used)
    union = expected | actual
    return {
        "accuracy": 100 * len(expected & actual) / len(union) if union else 100,
        "required": sorted(expected),
        "used": sorted(actual),
        "matched": sorted(expected & actual),
        "missing": sorted(expected - actual),
        "unexpected": sorted(actual - expected),
    }


def score(case, raw, status, used_tools=None):
    parsed, error = None, None
    try:
        parsed = parse_answer(raw)
    except (ValueError, TypeError, RecursionError):
        error = "invalid_answer_format"
    fields = {}
    for key, expected in case["expected"].items():
        present = parsed is not None and key in parsed["answers"]
        actual = parsed["answers"].get(key) if present else None
        rule = case["comparison"][key]
        correct = present and exact(expected, actual)
        if present and rule["type"] == "numeric_tolerance":
            correct = (
                type(actual) in (int, float)
                and math.isfinite(actual)
                and math.isclose(
                    actual,
                    expected,
                    abs_tol=rule.get("absolute_tolerance", 0),
                    rel_tol=rule.get("relative_tolerance", 0),
                )
            )
        # An incomplete/failed execution cannot earn credit from partial text.
        fields[key] = {
            "correct": bool(correct and status == "completed"),
            "present": present,
            "actual": actual,
        }
    success = (
        status == "completed"
        and error is None
        and all(f["correct"] for f in fields.values())
    )
    return {
        "scoring_version": SCORING_VERSION,
        "tool_selection": tool_selection(case.get("required_tools"), used_tools),
        "parsed": parsed,
        "fields": fields,
        "success": success,
        "error": "execution_failed" if status != "completed" else error,
    }


def summary(attempts, repetitions, complete):
    finished = [a for a in attempts if a.get("result") is not None]
    times = sorted(a["latency_ms"] for a in finished if a.get("latency_ms") is not None)
    result = {
        "finished": len(finished),
        "total": len(attempts),
        "timed_attempts": len(times),
        "answer_correctness": None,
        "tool_selection_accuracy": None,
        "tool_scored_attempts": 0,
        "task_success_rate": None,
        "pass_k": None,
        "median_latency_ms": None,
        "p95_latency_ms": None,
    }
    if times:
        n = len(times)
        result["median_latency_ms"] = (times[(n - 1) // 2] + times[n // 2]) / 2
        result["p95_latency_ms"] = times[math.ceil(0.95 * n) - 1]
    if not complete or not finished:
        return result
    tool_scores = [
        a["result"]["tool_selection"]["accuracy"]
        for a in finished
        if a["result"].get("tool_selection") is not None
    ]
    result["tool_scored_attempts"] = len(tool_scores)
    if tool_scores:
        result["tool_selection_accuracy"] = sum(tool_scores) / len(tool_scores)
    fields = [f for a in finished for f in a["result"]["fields"].values()]
    result["answer_correctness"] = 100 * sum(f["correct"] for f in fields) / len(fields)
    result["task_success_rate"] = (
        100 * sum(a["result"]["success"] for a in finished) / len(attempts)
    )
    grouped = {}
    for a in finished:
        grouped.setdefault(a["case_id"], []).append(a["result"]["success"])
    if all(len(values) == repetitions for values in grouped.values()):
        result["pass_k"] = {
            str(k): 100
            * sum(
                math.comb(sum(v), k) / math.comb(repetitions, k)
                for v in grouped.values()
            )
            / len(grouped)
            for k in sorted({1, repetitions})
        }
    return result
