"""Provider identity/accounting has no model generation capability."""

from datetime import UTC, datetime
from typing import Any

from psycopg import Connection

from dive_trip.modules.planning.evidence import Binding
from dive_trip.modules.usage import transactions as usage
from dive_trip.modules.usage.public import (
    ModelUsageEvent,
    ProviderBinding,
    reference_cost,
)
from dive_trip.platform.errors import DomainError


class RuntimeAccounting:
    def __init__(self, provider: ProviderBinding) -> None:
        self.provider = provider

    def authorize(
        self, connection: Connection[dict[str, Any]], binding: Binding, active: bool
    ) -> None:
        usage.require_binding(connection, binding.runId, self.provider)
        if active:
            usage.require_active(
                connection,
                usage.start_invocation(connection, binding.runId),
                binding.ownerId,
            )

    def start(
        self, connection: Connection[dict[str, Any]], binding: Binding, call_id: str
    ) -> None:
        if not usage.record_start(
            connection, usage.start_invocation(connection, binding.runId), call_id
        ):
            raise DomainError("MODEL_DISPATCH_CONFLICT")

    def complete(
        self,
        connection: Connection[dict[str, Any]],
        binding: Binding,
        event: ModelUsageEvent,
    ) -> None:
        usage.record_usage(
            connection, usage.start_invocation(connection, binding.runId), event
        )

    def settle(
        self,
        connection: Connection[dict[str, Any]],
        binding: Binding,
        *,
        failed: bool = False,
        rejected_activity: str | None = None,
    ) -> None:
        row = usage.start_invocation(connection, binding.runId)
        if row["status"] == "settled":
            return
        events, known = usage.usage_events(connection, row)
        costs = [reference_cost(self.provider, event) for event in events]
        rejected_known = False
        if failed and rejected_activity is not None and row["status"] == "active":
            try:
                usage.require_active(connection, row, binding.ownerId)
                rejected_known = any(
                    event.callId == rejected_activity for event in events
                )
            except DomainError:
                pass
        actual = (
            sum(cost for cost in costs if cost is not None)
            if (
                (not failed or rejected_known)
                and known
                and bool(events)
                and all(cost is not None for cost in costs)
            )
            else None
        )
        if actual is not None and actual > 9007199254740991:
            actual = None
        usage.settle_invocation(
            connection, row, binding.ownerId, actual, datetime.now(UTC)
        )
