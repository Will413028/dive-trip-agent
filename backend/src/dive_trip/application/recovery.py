"""Product-owned lease expiry, independent of Temporal worker availability."""

from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.compiler import compile_failure
from dive_trip.modules.planning.evidence import Binding, Compilation
from dive_trip.modules.usage import transactions as usage

from .runtime_accounting import RuntimeAccounting


def recover_expired(
    connection: planning.ConnectionType, owner: str, trip_id: str
) -> None:
    # Caller holds quota/global, owner and trip locks and rechecks their TTL.
    # Historical ADK executions are deliberately outside this writer's scope.
    for row in planning.expired_runs(connection, trip_id):
        binding = Binding(
            ownerId=owner,
            tripId=trip_id,
            runId=str(row["id"]),
            baseVersion=row["base_version"],
        )
        provider = usage.bound_provider(connection, binding.runId)
        planning.end_failed(
            connection,
            trip_id,
            binding.runId,
            compile_failure(Compilation(binding, "failure-answer", ())),
            interrupted=True,
        )
        if provider is not None:
            RuntimeAccounting(provider).settle(connection, binding, failed=True)
