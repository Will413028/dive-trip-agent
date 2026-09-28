from typing import Any, Literal

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.identity.public import require_owner
from dive_trip.modules.planning.public import require_manual_proposal
from dive_trip.modules.trips.public import ProposalDraft
from dive_trip.modules.trips.transactions import (
    TripView,
    claim_receipt,
    create_trip,
    get_trip,
    mutate_trip,
    mutation_identity,
    proposal_view,
    reject_proposal,
    require_base,
    save_proposal,
    valid_ids,
)
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError


class TripService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def create(self, owner: str, raw: Any) -> TripView:
        valid_ids(owner)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            return create_trip(connection, owner, raw)

    def get(self, owner: str, trip_id: str) -> TripView:
        valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            trip = get_trip(connection, owner, trip_id)
            require_owner(connection, owner)
            return trip

    def propose(
        self,
        owner: str,
        trip_id: str,
        base_version: int,
        changes: Any,
        catalog: list[CatalogItem],
    ) -> tuple[str, ProposalDraft]:
        valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            trip = get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            require_base(trip, base_version)
            return save_proposal(connection, trip, changes, catalog)

    def proposal(self, owner: str, trip_id: str, proposal_id: str) -> dict[str, Any]:
        valid_ids(owner, trip_id, proposal_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            get_trip(connection, owner, trip_id, lock=True)
            result = proposal_view(connection, trip_id, proposal_id)
            get_trip(connection, owner, trip_id)
            require_owner(connection, owner)
            return result

    def mutate(
        self,
        owner: str,
        trip_id: str,
        base_version: int,
        request_id: str,
        operation: Literal["apply", "restore"],
        target: str | int,
    ) -> TripView:
        valid_ids(owner, trip_id)
        if type(base_version) is not int or not 1 <= base_version <= 2147483647:
            raise DomainError("INVALID_PROPOSAL")
        if operation == "apply":
            if not isinstance(target, str):
                raise DomainError("INVALID_PROPOSAL")
            valid_ids(target)
        payload_hash = mutation_identity(operation, trip_id, base_version, target)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            receipt = claim_receipt(
                connection, owner, request_id, operation, payload_hash
            )
            trip = get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            if operation == "apply":
                assert isinstance(target, str)
                require_manual_proposal(connection, target)
            return mutate_trip(
                connection,
                owner,
                trip,
                base_version,
                request_id,
                operation,
                target,
                receipt,
                payload_hash,
            )

    def reject(self, owner: str, trip_id: str, proposal_id: str) -> None:
        valid_ids(owner, trip_id, proposal_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            trip = get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner)
            require_manual_proposal(connection, proposal_id)
            reject_proposal(connection, trip, proposal_id)
