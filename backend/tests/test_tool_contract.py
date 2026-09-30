import json

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


def test_rejected_arguments_keep_only_bounded_allowlisted_private_diagnostic():
    raw = {
        "changes": [
            {"kind": "requirements", "value": {"private_field": "SECRET_VALUE"}}
            for _ in range(12)
        ]
        + [{"kind": "requirements", "value": {"days": "5"}}]
    }
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate([call("validate_changes", raw)], set(), 0)
    diagnostic = caught.value.diagnostic
    assert diagnostic is not None
    assert diagnostic.tool == "validate_changes"
    assert diagnostic.candidate_ordinal == 1
    assert len(diagnostic.issues) == 2
    assert diagnostic.issues[0].model_dump() == {
        "code": "extra_forbidden",
        "path": ["changes", "*", "requirements", "value", "?"],
    }
    assert diagnostic.issues[1].model_dump() == {
        "code": "invalid_value",
        "path": ["changes", "*", "requirements", "value", "days"],
    }
    serialized = json.dumps(diagnostic.model_dump(mode="json"))
    assert "private_field" not in serialized
    assert "SECRET_VALUE" not in serialized
    assert str(caught.value) == "AGENT_TOOL_ARGUMENTS_REJECTED"


def test_rejected_known_field_reports_fixed_error_class_and_path():
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate(
            [
                call(
                    "validate_changes",
                    {"changes": [{"kind": "requirements", "value": {"days": "5"}}]},
                )
            ],
            set(),
            0,
        )
    assert caught.value.diagnostic.issues[0].model_dump() == {
        "code": "invalid_value",
        "path": ["changes", "*", "requirements", "value", "days"],
    }


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"private_field": "SECRET_VALUE"}, "kind_missing"),
        ({"kind": "SECRET_VALUE"}, "kind_invalid"),
        ({"kind": None}, "kind_invalid"),
        ({"kind": 42}, "kind_invalid"),
        ({"kind": "requirements", "value": {}}, "invalid_value"),
    ],
)
def test_change_kind_diagnostic_distinguishes_tags_without_retaining_values(
    change, code
):
    prior = {"before"}
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate(
            [call("validate_changes", {"changes": [change]})], prior, 0
        )
    diagnostic = caught.value.diagnostic
    assert diagnostic is not None
    assert diagnostic.issues[0].code == code
    assert diagnostic.issues[0].path == (
        ["changes", "*", "requirements"]
        if code == "invalid_value"
        else ["changes", "*"]
    )
    assert "SECRET_VALUE" not in diagnostic.model_dump_json()
    assert "private_field" not in diagnostic.model_dump_json()
    assert prior == {"before"}
    assert str(caught.value) == "AGENT_TOOL_ARGUMENTS_REJECTED"


def test_historical_generic_diagnostic_remains_readable():
    from dive_trip.modules.planning.argument_diagnostic import ArgumentDiagnostic

    historical = {
        "tool": "validate_changes",
        "candidate_ordinal": 1,
        "issues": [{"code": "invalid_value", "path": ["changes", "*"]}],
    }
    assert ArgumentDiagnostic.model_validate(historical).model_dump() == historical


def test_extra_field_is_redacted_even_when_its_name_exists_in_another_tool():
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate(
            [call("calculate_budget", {"id": "SECRET_VALUE"})], set(), 0
        )
    assert caught.value.diagnostic.issues[0].model_dump() == {
        "code": "extra_forbidden",
        "path": ["?"],
    }


def test_duplicate_tool_names_identify_rejected_candidate_by_batch_ordinal():
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate(
            [
                call("calculate_budget"),
                call("calculate_budget", {"private_field": "SECRET"}, "second"),
            ],
            set(),
            0,
        )
    assert caught.value.diagnostic.candidate_ordinal == 2
    assert "second" not in caught.value.diagnostic.model_dump_json()


def test_identifier_guard_uses_same_private_diagnostic_without_identifier_value():
    with pytest.raises(ToolArgumentsRejected) as caught:
        validate_candidate(
            [
                call(
                    "validate_changes",
                    {
                        "changes": [
                            {"kind": "remove", "entryId": "SECRET\0IDENTIFIER"}
                        ]
                    },
                )
            ],
            set(),
            0,
        )
    assert caught.value.diagnostic.issues[0].model_dump() == {
        "code": "invalid_value",
        "path": ["changes", "*", "entryId"],
    }
    assert "SECRET" not in caught.value.diagnostic.model_dump_json()


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
