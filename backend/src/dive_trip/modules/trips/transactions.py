"""Public transaction operations; application owns cross-module gates and commit."""

import hashlib
import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from psycopg import Connection
from psycopg.types.json import Jsonb

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.platform.errors import DomainError
from dive_trip.platform.schema import PositiveInt, WireModel

from . import deletion as deletion
from .domain import Budget, Snapshot, budget_model
from .proposal import ProposalDraft, build_proposal
from .snapshot import parse_snapshot

ConnectionType = Connection[dict[str, Any]]


class TripView(WireModel):
    id: str
    version: PositiveInt
    snapshot: Snapshot
    budget: Budget


def valid_ids(*values: str) -> None:
    try:
        for value in values:
            UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise DomainError("NOT_FOUND") from None


def view(trip_id: str, version: int, raw: Any) -> TripView:
    snapshot = parse_snapshot(raw)
    return TripView(
        id=trip_id, version=version, snapshot=snapshot, budget=budget_model(snapshot)
    )


def get_trip(
    connection: ConnectionType, owner: str, trip_id: str, *, lock: bool = False
) -> TripView:
    valid_ids(owner, trip_id)
    if lock:
        row = connection.execute(
            """
            SELECT id FROM trips WHERE id=%s AND owner_id=%s
            AND expires_at>clock_timestamp() AND deletion_requested_at IS NULL
            FOR UPDATE
            """,
            (trip_id, owner),
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
    # Read after waiting to observe the winning version and elapsed TTL.
    row = connection.execute(
        """
        SELECT t.current_version,v.snapshot FROM trips t
        JOIN trip_versions v ON v.trip_id=t.id AND v.version=t.current_version
        WHERE t.id=%s AND t.owner_id=%s AND t.expires_at>clock_timestamp()
        AND t.deletion_requested_at IS NULL
        """,
        (trip_id, owner),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return view(trip_id, row["current_version"], row["snapshot"])


def require_base(trip: TripView, base_version: int) -> None:
    if trip.version != base_version:
        raise DomainError("STALE_VERSION")


def get_version(connection: ConnectionType, trip_id: str, version: int) -> Snapshot:
    row = connection.execute(
        "SELECT snapshot FROM trip_versions WHERE trip_id=%s AND version=%s",
        (trip_id, version),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return parse_snapshot(row["snapshot"])


def proposal_view(
    connection: ConnectionType, trip_id: str, proposal_id: str
) -> dict[str, Any]:
    row = connection.execute(
        "SELECT draft,base_version FROM proposals WHERE trip_id=%s AND id=%s",
        (trip_id, proposal_id),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    base = get_version(connection, trip_id, row["base_version"])
    from .review import review_proposal

    draft = ProposalDraft.model_validate(row["draft"])
    draft_value = draft.model_dump(mode="json")
    for issue in draft_value["issues"]:
        if issue["entryId"] is None:
            del issue["entryId"]
    return {
        "draft": draft_value,
        "base": view(trip_id, row["base_version"], base).model_dump(mode="json"),
        "review": review_proposal(base, draft),
    }


def trip_expiry(connection: ConnectionType, trip_id: str) -> datetime:
    row = connection.execute(
        "SELECT expires_at FROM trips WHERE id=%s AND expires_at>clock_timestamp()",
        (trip_id,),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    result: datetime = row["expires_at"]
    return result


def worker_owner(connection: ConnectionType, trip_id: str) -> str:
    """Trusted worker lookup; application must authenticate its bound run afterward."""
    row = connection.execute(
        "SELECT owner_id FROM trips WHERE id=%s", (trip_id,)
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    return str(row["owner_id"])


def create_trip(connection: ConnectionType, owner: str, raw: Any) -> TripView:
    snapshot = parse_snapshot(raw)
    identity = str(uuid4())
    connection.execute(
        "INSERT INTO trips(id,owner_id,current_version) VALUES(%s,%s,1)",
        (identity, owner),
    )
    connection.execute(
        "INSERT INTO trip_versions(trip_id,version,snapshot) VALUES(%s,1,%s)",
        (identity, Jsonb(snapshot.model_dump(mode="json"))),
    )
    return view(identity, 1, snapshot)


def save_proposal(
    connection: ConnectionType, trip: TripView, changes: Any, catalog: list[CatalogItem]
) -> tuple[str, ProposalDraft]:
    draft = build_proposal(trip.snapshot, changes, catalog, "user")
    if any(issue.code == "INVALID_CHANGE" for issue in draft.issues):
        raise DomainError("INVALID_PROPOSAL")
    identity = str(uuid4())
    connection.execute(
        """
        INSERT INTO proposals(id,trip_id,base_version,draft,catalog_snapshot)
        VALUES(%s,%s,%s,%s,%s)
        """,
        (
            identity,
            trip.id,
            trip.version,
            Jsonb(draft.model_dump(mode="json")),
            Jsonb([item.model_dump(mode="json") for item in catalog]),
        ),
    )
    return identity, draft


def mutation_identity(
    operation: Literal["apply", "restore"],
    trip_id: str,
    base_version: int,
    target: str | int,
) -> str:
    return hashlib.sha256(
        json.dumps(
            [operation, trip_id, base_version, target], separators=(",", ":")
        ).encode()
    ).hexdigest()


def claim_receipt(
    connection: ConnectionType,
    owner: str,
    request_id: str,
    operation: Literal["apply", "restore"],
    payload_hash: str,
) -> dict[str, Any]:
    if (
        not isinstance(request_id, str)
        or not request_id.strip()
        or len(request_id) > 128
    ):
        raise DomainError("INVALID_PROPOSAL")
    connection.execute(
        """
        INSERT INTO mutation_receipts(owner_id,request_id,operation,payload_hash)
        VALUES(%s,%s,%s,%s) ON CONFLICT(owner_id,request_id) DO NOTHING
        """,
        (owner, request_id, operation, payload_hash),
    )
    row = connection.execute(
        """
        SELECT payload_hash,response FROM mutation_receipts
        WHERE owner_id=%s AND request_id=%s FOR UPDATE
        """,
        (owner, request_id),
    ).fetchone()
    assert row is not None
    return row


def mutate_trip(
    connection: ConnectionType,
    owner: str,
    trip: TripView,
    base_version: int,
    request_id: str,
    operation: Literal["apply", "restore"],
    target: str | int,
    receipt: dict[str, Any],
    payload_hash: str,
) -> TripView:
    if receipt["payload_hash"] != payload_hash:
        raise DomainError("IDEMPOTENCY_CONFLICT")
    if receipt["response"] is not None:
        stored = TripView.model_validate(receipt["response"])
        if stored.id != trip.id or stored != view(
            stored.id, stored.version, stored.snapshot
        ):
            raise DomainError("INVALID_PROPOSAL")
        return stored
    require_base(trip, base_version)
    if trip.version == 2147483647:
        raise DomainError("INVALID_PROPOSAL")
    if operation == "apply":
        row = connection.execute(
            "SELECT * FROM proposals WHERE id=%s AND trip_id=%s", (target, trip.id)
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
        if row["base_version"] != trip.version or row["status"] == "stale":
            raise DomainError("STALE_VERSION")
        if row["status"] != "pending":
            raise DomainError("INVALID_PROPOSAL")
        draft = ProposalDraft.model_validate(row["draft"])
        catalog = [CatalogItem.model_validate(item) for item in row["catalog_snapshot"]]
        rebuilt = build_proposal(
            trip.snapshot,
            [change.model_dump() for change in draft.changes],
            catalog,
            "user",
        )
        if rebuilt != draft or not rebuilt.canApply:
            raise DomainError("INVALID_PROPOSAL")
        snapshot = rebuilt.next
        connection.execute(
            "UPDATE proposals SET status='applied' WHERE id=%s", (target,)
        )
    else:
        if type(target) is not int or not 1 <= target <= 2147483647:
            raise DomainError("INVALID_PROPOSAL")
        row = connection.execute(
            "SELECT snapshot FROM trip_versions WHERE trip_id=%s AND version=%s",
            (trip.id, target),
        ).fetchone()
        if row is None:
            raise DomainError("NOT_FOUND")
        snapshot = parse_snapshot(row["snapshot"])
    result = view(trip.id, trip.version + 1, snapshot)
    connection.execute(
        "INSERT INTO trip_versions(trip_id,version,snapshot) VALUES(%s,%s,%s)",
        (trip.id, result.version, Jsonb(result.snapshot.model_dump(mode="json"))),
    )
    connection.execute(
        "UPDATE trips SET current_version=%s WHERE id=%s", (result.version, trip.id)
    )
    connection.execute(
        "UPDATE proposals SET status='stale' WHERE trip_id=%s AND status='pending'",
        (trip.id,),
    )
    connection.execute(
        """
        UPDATE mutation_receipts SET trip_id=%s,response=%s
        WHERE owner_id=%s AND request_id=%s
        """,
        (trip.id, Jsonb(result.model_dump(mode="json")), owner, request_id),
    )
    return result


def reject_proposal(
    connection: ConnectionType, trip: TripView, proposal_id: str
) -> None:
    row = connection.execute(
        "SELECT status FROM proposals WHERE id=%s AND trip_id=%s",
        (proposal_id, trip.id),
    ).fetchone()
    if row is None:
        raise DomainError("NOT_FOUND")
    if row["status"] == "rejected":
        return
    if row["status"] != "pending":
        raise DomainError("INVALID_PROPOSAL")
    connection.execute(
        "UPDATE proposals SET status='rejected',rejection_version=%s WHERE id=%s",
        (trip.version, proposal_id),
    )
