"""Owner-checked stored projections, independent of a running worker."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from dive_trip.modules.identity.public import require_owner
from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.evidence import Binding
from dive_trip.modules.trips import transactions as trips
from dive_trip.modules.usage.public import lock_global
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError

from .recovery import recover_expired


class RunQueries:
    def __init__(self, database: Database) -> None:
        self.database = database

    @contextmanager
    def scope(self, owner: str, trip_id: str) -> Iterator[planning.ConnectionType]:
        trips.valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, owner, lock=True)
            trips.get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            recover_expired(connection, owner, trip_id)
            yield connection
            # Recheck after all database waits before releasing the projection.
            trips.get_trip(connection, owner, trip_id)
            require_owner(connection, owner)

    def list(self, owner: str, trip_id: str) -> list[dict[str, Any]]:
        with self.scope(owner, trip_id) as connection:
            result = planning.run_views(connection, trip_id)
            for run in result:
                if run["answerContractVersion"] == 1 and run["proposalId"]:
                    run["proposal"] = trips.proposal_view(
                        connection, trip_id, run["proposalId"]
                    )
            return result

    def get(
        self, owner: str, trip_id: str, run_id: str, *, after_sequence: int = 0
    ) -> dict[str, Any]:
        trips.valid_ids(run_id)
        with self.scope(owner, trip_id) as connection:
            result = planning.run_views(
                connection, trip_id, run_id, after_sequence=after_sequence
            )
            if not result:
                raise DomainError("NOT_FOUND")
            return result[0]

    def binding(self, owner: str, trip_id: str, run_id: str) -> Binding:
        row = self.get(owner, trip_id, run_id)
        if row["executor"] != "temporal-v1" or row["answerContractVersion"] != 1:
            raise DomainError("RUN_STATE_CONFLICT")
        return Binding(
            ownerId=owner,
            tripId=trip_id,
            runId=run_id,
            baseVersion=row["baseVersion"],
        )
