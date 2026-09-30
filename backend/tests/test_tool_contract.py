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


@pytest.mark.parametrize(
    ("candidate", "suffix"),
    [
        ([call("final_answer")], "FINAL_ONLY"),
        ([call("calculate_budget")], "BUDGET_ONLY"),
        ([call("find_items")], "BUSINESS_ONLY"),
        ([call("find_items"), call("validate_changes")], "BUSINESS_ONLY"),
        ([call("calculate_budget"), call("final_answer")], "MIXED_NAMES"),
        ([call("calculate_budget"), call("find_items")], "MIXED_NAMES"),
        ([call("PRIVATE_UNKNOWN_NAME")], "UNDECLARED_NAME"),
        ([call("calculate_budget"), call("PRIVATE_UNKNOWN_NAME")], "UNDECLARED_NAME"),
        ([{"name": ["PRIVATE_UNKNOWN_NAME"]}], "INVALID_NAME_SHAPE"),
        ([{}], "INVALID_NAME_SHAPE"),
        (["PRIVATE_CANDIDATE"], "INVALID_NAME_SHAPE"),
        ([call("PRIVATE_UNKNOWN_NAME"), None], "INVALID_NAME_SHAPE"),
    ],
)
def test_limit_classifies_only_fixed_name_categories_without_preserving_values(
    candidate, suffix
):
    prior = {"prior-call"}
    for ordered in (candidate, list(reversed(candidate))):
        with pytest.raises(DomainError) as caught:
            validate_candidate(ordered, prior, 6)
        code = f"AGENT_TOOL_LIMIT_{suffix}"
        assert caught.value.code == str(caught.value) == code
        assert caught.value.args == (code,)
        assert vars(caught.value) == {"code": code}
        assert prior == {"prior-call"}


def test_limit_diagnostic_does_not_validate_or_store_arguments_and_call_ids():
    raw = [call("final_answer", {"PRIVATE_ARGUMENT": "SECRET"}, "PRIVATE_CALL_ID")]
    with pytest.raises(DomainError, match="^AGENT_TOOL_LIMIT_FINAL_ONLY$") as caught:
        validate_candidate(raw, set(), 6)
    assert vars(caught.value) == {"code": "AGENT_TOOL_LIMIT_FINAL_ONLY"}
    with pytest.raises(DomainError, match="^AGENT_ANSWER_SCHEMA$"):
        validate_candidate(raw, set(), 5)


def test_limit_classifies_whole_batch_crossing_remaining_slot():
    prior = {"prior-call"}
    raw = [call("calculate_budget"), call("find_destinations", identity="call-2")]
    with pytest.raises(DomainError, match="^AGENT_TOOL_LIMIT_MIXED_NAMES$"):
        validate_candidate(raw, prior, 5)
    assert prior == {"prior-call"}
    assert len(validate_candidate(raw, prior, 4)) == 2


def test_output_size_guard_precedes_tool_limit_classification():
    raw = [call("PRIVATE_UNKNOWN_NAME", {"private": "SECRET" * 6000})]
    with pytest.raises(DomainError, match="^AGENT_OUTPUT_LIMIT$") as caught:
        validate_candidate(raw, set(), 6)
    assert vars(caught.value) == {"code": "AGENT_OUTPUT_LIMIT"}


def test_duplicate_call_id_across_history_is_rejected():
    with pytest.raises(DomainError, match="^AGENT_MODEL_RESPONSE_REUSED_CALL_ID$"):
        validate_candidate([call("calculate_budget")], {"call-1"}, 1)
    with pytest.raises(DomainError, match="^AGENT_MODEL_RESPONSE_DUPLICATE_CALL_ID$"):
        validate_candidate(
            [call("calculate_budget"), call("find_destinations")], set(), 0
        )


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ({"SECRET": "raw-value"}, "AGENT_MODEL_RESPONSE_CANDIDATES_SHAPE"),
        ([], "AGENT_MODEL_RESPONSE_EMPTY_CALLS"),
    ],
)
def test_candidate_container_diagnostic_does_not_store_values(raw, code):
    with pytest.raises(DomainError) as caught:
        validate_candidate(raw, set(), 0)
    assert str(caught.value) == code
    assert vars(caught.value) == {"code": code}
