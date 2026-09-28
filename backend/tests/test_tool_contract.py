import pytest

from dive_trip.modules.planning.tool_contract import validate_candidate
from dive_trip.platform.errors import DomainError, ToolArgumentsRejected


def call(name, args=None, identity="call-1"):
    return {"id": identity, "name": name, "args": args or {}}


def test_last_bad_call_rejects_entire_candidate_without_mutating_prior_ids():
    prior = {"before"}
    with pytest.raises(DomainError, match="AGENT_TOOL_NOT_ALLOWED"):
        validate_candidate(
            [call("calculate_budget"), call("apply_changes", identity="call-2")],
            prior,
            0,
        )
    assert prior == {"before"}


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"days": None},
        {"days": "5"},
        {"startDate": "2026-02-30"},
        {"actor": "user"},
        {"people": True},
    ],
)
def test_partial_patch_rejects_invalid_fields(patch):
    with pytest.raises(ToolArgumentsRejected):
        validate_candidate(
            [
                call(
                    "validate_changes",
                    {"changes": [{"kind": "requirements", "value": patch}]},
                )
            ],
            set(),
            0,
        )


def test_partial_patch_preserves_omission_and_explicit_null():
    result = validate_candidate(
        [
            call(
                "validate_changes",
                {"changes": [{"kind": "requirements", "value": {"budgetMinor": None}}]},
            )
        ],
        set(),
        0,
    )
    assert result[0].args == {
        "changes": [{"kind": "requirements", "value": {"budgetMinor": None}}]
    }


def test_final_output_counts_as_tool_and_is_exclusive():
    final = call(
        "final_answer",
        {"version": "1", "answer": {"kind": "clarify", "fields": ["budget"]}},
    )
    assert validate_candidate([final], set(), 5)[0].name == "final_answer"
    with pytest.raises(DomainError, match="AGENT_TOOL_LIMIT"):
        validate_candidate([final], set(), 6)
    with pytest.raises(DomainError, match="AGENT_ANSWER_SCHEMA"):
        validate_candidate(
            [final, call("calculate_budget", identity="call-2")], set(), 0
        )


def test_duplicate_call_id_across_history_is_rejected():
    with pytest.raises(DomainError, match="AGENT_MODEL_RESPONSE"):
        validate_candidate([call("calculate_budget")], {"call-1"}, 1)
    with pytest.raises(DomainError, match="AGENT_MODEL_RESPONSE"):
        validate_candidate(
            [call("calculate_budget"), call("find_destinations")], set(), 0
        )
