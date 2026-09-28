from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.identity.public import owner_expiry, require_owner
from dive_trip.modules.sharing import transactions as shares
from dive_trip.modules.sharing.public import PublicTrip, hash_preview, preview_share
from dive_trip.modules.trips import transactions as trips
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError


class SharingService:
    def __init__(self, database: Database, catalog: list[CatalogItem]) -> None:
        self.database, self.catalog = database, catalog

    @contextmanager
    def scope(
        self, owner: str, trip_id: str
    ) -> Iterator[tuple[Any, trips.TripView, datetime]]:
        trips.valid_ids(owner, trip_id)
        with self.database.transaction() as connection:
            require_owner(connection, owner, lock=True)
            trip = trips.get_trip(connection, owner, trip_id, lock=True)
            expiry = min(
                owner_expiry(connection, owner), trips.trip_expiry(connection, trip_id)
            )
            yield connection, trip, expiry
            trips.get_trip(connection, owner, trip_id)
            require_owner(connection, owner)

    def preview(self, owner: str, trip_id: str, version: int) -> dict[str, Any]:
        with self.scope(owner, trip_id) as (_, trip, expiry):
            trips.require_base(trip, version)
            preview = preview_share(trip.snapshot, self.catalog)
            return {
                "preview": preview.model_dump(mode="json"),
                "previewHash": hash_preview(preview),
                "version": version,
                "expiresAt": shares.timestamp(expiry),
            }

    def create(
        self, owner: str, trip_id: str, version: int, preview_hash: str
    ) -> dict[str, Any]:
        with self.scope(owner, trip_id) as (connection, trip, expiry):
            trips.require_base(trip, version)
            preview = preview_share(trip.snapshot, self.catalog)
            if hash_preview(preview) != preview_hash:
                raise DomainError("SHARE_PREVIEW_CHANGED")
            return shares.create(connection, trip_id, version, preview, expiry)

    def list(self, owner: str, trip_id: str) -> list[dict[str, Any]]:
        with self.scope(owner, trip_id) as (connection, _, _):
            return shares.list_shares(connection, trip_id)

    def revoke(self, owner: str, trip_id: str, share_id: str) -> None:
        trips.valid_ids(share_id)
        with self.scope(owner, trip_id) as (connection, _, _):
            shares.revoke(connection, trip_id, share_id)

    def read(self, token: str) -> PublicTrip:
        with self.database.transaction() as connection:
            row = shares.find_token(connection, token)
            if row is None:
                raise DomainError("NOT_FOUND")
            trip_id = str(row["trip_id"])
            owner = trips.worker_owner(connection, trip_id)
            require_owner(connection, owner, lock=True)
            trips.get_trip(connection, owner, trip_id, lock=True)
            # Re-read after the trip lock; revoke/delete use the same ordering.
            current = shares.find_token(connection, token)
            if current is None:
                raise DomainError("NOT_FOUND")
            result = PublicTrip.model_validate(current["snapshot"])
            trips.get_trip(connection, owner, trip_id)
            require_owner(connection, owner)
            return result
