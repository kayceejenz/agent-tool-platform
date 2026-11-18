"""Tool-use metrics shared by benchmarks and human-defined expected steps."""


def same_json(expected, actual):
    # JSON numbers can use different representations; booleans are not numbers.
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, dict) and isinstance(actual, dict):
        return expected.keys() == actual.keys() and all(
            same_json(value, actual[key]) for key, value in expected.items()
        )
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            same_json(a, b) for a, b in zip(expected, actual, strict=True)
        )
    return expected == actual


def argument_score(expected, actual, schema):
    defaults = {
        key: value["default"]
        for key, value in schema.get("properties", {}).items()
        if "default" in value
    }
    # Only supplied fields count; unrelated defaults cannot inflate the score.
    keys = expected.keys() | {
        key
        for key, value in actual.items()
        if key in expected or key not in defaults or not same_json(value, defaults[key])
    }
    matched = sum(
        (key in expected or key in defaults)
        and (key in actual or key in defaults)
        and same_json(
            expected.get(key, defaults.get(key)), actual.get(key, defaults.get(key))
        )
        for key in keys
    )
    return {
        "matched": matched,
        "total": len(keys),
        "accuracy": 100 * matched / len(keys) if keys else 100.0,
    }


def score_call(reference, calls):
    selected = [c for c in calls if str(c.get("tool_id")) == str(reference["tool_id"])]
    best = max(
        (
            argument_score(
                reference["arguments"], c["inputs"], reference.get("input_schema") or {}
            )
            for c in selected
        ),
        key=lambda result: result["accuracy"],
        default=None,
    )
    return {
        "actual_count": len(calls),
        "matched_count": int(bool(selected)),
        "arguments_correct": best["accuracy"] == 100 if best else None,
        "argument_accuracy": best["accuracy"] if best else None,
        "matched_arguments": best["matched"] if best else None,
        "total_arguments": best["total"] if best else None,
    }


def percentage(numerator, denominator):
    return 100 * numerator / denominator if denominator else None


def totals(scores):
    matched = sum(s["matched_count"] for s in scores)
    actual = sum(s["actual_count"] for s in scores)
    accuracy = sum(s["argument_accuracy"] or 0 for s in scores)
    return {
        "scored": len(scores),
        "precision": percentage(matched, actual),
        "recall": percentage(matched, len(scores)),
        "arguments": accuracy / matched if matched else None,
    }


def model_performance(runs):
    """Aggregate finished benchmark runs by agent, including retries."""
    groups = {}
    for run in runs:
        key = run["agent_id"]
        groups.setdefault(key, []).append(run)
    items = []
    for agent_id, rows in groups.items():
        metrics = totals([score_call(row, row["calls"]) for row in rows])
        latencies = [row["latency_ms"] for row in rows if row["latency_ms"] is not None]
        items.append(
            {
                "agent_id": str(agent_id),
                "agent_name": rows[-1]["agent_name"],
                "runs": len(rows),
                "questions": len({row["benchmark_id"] for row in rows}),
                "completed": sum(row["status"] == "completed" for row in rows),
                "completion_rate": percentage(
                    sum(row["status"] == "completed" for row in rows), len(rows)
                ),
                "precision": metrics["precision"],
                "recall": metrics["recall"],
                "argument_accuracy": metrics["arguments"],
                "latency_ms": sum(latencies) / len(latencies) if latencies else None,
            }
        )
    return sorted(
        items,
        key=lambda row: (
            -(row["recall"] or 0),
            -(row["argument_accuracy"] or 0),
            -row["completion_rate"],
            row["latency_ms"] if row["latency_ms"] is not None else float("inf"),
            row["agent_name"],
            row["agent_id"],
        ),
    )


def _maximum_argument_agreement(matrix):
    """Maximum-weight one-to-one matching (Hungarian assignment, O(n²m))."""
    if not matrix or not matrix[0]:
        return 0
    if len(matrix) > len(matrix[0]):
        matrix = [list(column) for column in zip(*matrix)]
    n, m = len(matrix), len(matrix[0])
    u, v, matched, previous = (
        [0.0] * (n + 1),
        [0.0] * (m + 1),
        [0] * (m + 1),
        [0] * (m + 1),
    )
    for row in range(1, n + 1):
        matched[0], column = row, 0
        costs, used = [float("inf")] * (m + 1), [False] * (m + 1)
        while True:
            used[column] = True
            current_row, delta, next_column = matched[column], float("inf"), 0
            for j in range(1, m + 1):
                if not used[j]:
                    cost = -matrix[current_row - 1][j - 1] - u[current_row] - v[j]
                    if cost < costs[j]:
                        costs[j], previous[j] = cost, column
                    if costs[j] < delta:
                        delta, next_column = costs[j], j
            for j in range(m + 1):
                if used[j]:
                    u[matched[j]] += delta
                    v[j] -= delta
                else:
                    costs[j] -= delta
            column = next_column
            if matched[column] == 0:
                break
        while column:
            next_column = previous[column]
            matched[column] = matched[next_column]
            column = next_column
    return sum(matrix[matched[j] - 1][j - 1] for j in range(1, m + 1) if matched[j])


def score_steps(expected, calls):
    """Pair calls to the same tool once, maximizing argument agreement."""
    matched, agreement = 0, 0.0
    for key in {step["tool_key"] for step in expected}:
        references = [step for step in expected if step["tool_key"] == key]
        actual = [call for call in calls if call["tool_key"] == key]
        matched += min(len(references), len(actual))
        agreement += _maximum_argument_agreement(
            [
                [
                    argument_score(
                        step["arguments"],
                        call["inputs"],
                        step.get("input_schema") or {},
                    )["accuracy"]
                    for call in actual
                ]
                for step in references
            ]
        )
    return {
        "precision": percentage(matched, len(calls)),
        "recall": percentage(matched, len(expected)),
        "argument_accuracy": agreement / matched if matched else None,
        "expected_calls": len(expected),
        "actual_calls": len(calls),
        "matched_calls": matched,
    }
