from uuid import uuid4

import pytest
from test_admission import setup, start
from test_provider_sdk import binding as provider_binding
from test_provider_sdk import reply
from test_trip_transactions import owner

from dive_trip.application.planning import PlanningService
from dive_trip.application.runtime_accounting import RuntimeAccounting
from dive_trip.application.usage_evidence import UsageEvidence, read_usage_evidence
from dive_trip.modules.planning.answer_contract import AnswerPlan
from dive_trip.platform.errors import DomainError
from dive_trip.platform.provider_wire import wire_evidence


def prepared(database, provider):
    identity, trip, admission, catalog = setup(database)
    selected = provider_binding(provider)
    binding, _, _ = start(admission, identity, trip, selected)
    service = PlanningService(database, catalog, accounting=RuntimeAccounting(selected))
    service.begin_model(binding, "activity-1")
    return binding, selected, service


@pytest.mark.parametrize("provider", ["gemini", "openrouter", "cloudflare"])
@pytest.mark.parametrize("known", [True, False])
def test_private_v3_preserves_known_and_unknown_accounting(database, provider, known):
    binding, selected, service = prepared(database, provider)
    if known:
        event, failure = wire_evidence(selected, "activity-1", reply(provider))
        assert failure is None
        service.account_usage(binding, event)
        plan = {"version": "1", "answer": {"kind": "clarify", "fields": ["people"]}}
        service.complete_model(
            binding,
            "activity-1",
            [{"id": "final", "name": "final_answer", "args": plan}],
        )
        service.finish_answer(binding, AnswerPlan.model_validate(plan))
    else:
        service.recover(binding)
    evidence = read_usage_evidence(database, binding, selected)
    assert evidence.schemaVersion == 3
    assert evidence.executor == "temporal-v1"
    assert UsageEvidence.model_validate_json(evidence.model_dump_json()) == evidence
    assert len(evidence.calls) == len(evidence.steps) == 1
    invocation = evidence.invocations[0]
    assert invocation.status == "settled"
    if known:
        assert (
            invocation.actual_cost_micros
            == {"gemini": 4, "openrouter": 0, "cloudflare": 1}[provider]
        )
    else:
        assert invocation.actual_cost_micros is None
        assert invocation.charged_cost_micros == 50
        assert evidence.calls[0].event.usage is None
        assert evidence.calls[0].status == "started"
    dumped = evidence.model_dump_json()
    for excluded in ("prompt", "token_hash", "ip_key", "catalog", "message", "api_key"):
        # promptTokens is accounting; free-form prompt fields must not be exported.
        assert f'"{excluded}":' not in dumped
    assert read_usage_evidence(database, binding, selected) == evidence


@pytest.mark.parametrize(
    "tamper",
    [
        "owner",
        "ledger-owner",
        "missing-step",
        "missing-call",
        "extra-call",
        "extra-ledger",
    ],
)
def test_private_evidence_rejects_binding_and_inventory_drift(database, tamper):
    binding, selected, _ = prepared(database, "gemini")
    other = owner(database)
    with database.transaction() as connection:
        if tamper == "owner":
            binding = binding.model_copy(update={"ownerId": other})
        elif tamper == "ledger-owner":
            connection.execute("UPDATE quota_reservations SET owner_id=%s", (other,))
        elif tamper == "missing-step":
            connection.execute("DELETE FROM planning_model_steps")
        elif tamper == "missing-call":
            connection.execute("DELETE FROM model_calls")
        elif tamper == "extra-ledger":
            connection.execute(
                "INSERT INTO quota_reservations (id,owner_id,ip_key,request_id,"
                "payload_hash,day,reserved_at,expires_at,max_cost_micros,"
                "charged_cost_micros,actual_cost_micros,status,settled_at,"
                "logical_run_id) "
                "SELECT %s,owner_id,ip_key,'orphan',payload_hash,day,reserved_at,"
                "expires_at,max_cost_micros,charged_cost_micros,actual_cost_micros,"
                "status,settled_at,logical_run_id FROM quota_reservations LIMIT 1",
                (str(uuid4()),),
            )
        else:
            connection.execute(
                "INSERT INTO model_calls(invocation_id,run_id,call_id,status) "
                "SELECT invocation_id,run_id,'extra','started' FROM model_calls"
            )
    with pytest.raises((DomainError, ValueError)):
        read_usage_evidence(database, binding, selected)
