import hashlib
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from test_budget import snapshot

from dive_trip.application.trips import TripService
from dive_trip.modules.catalog.public import load_catalog
from dive_trip.platform.errors import DomainError

pytestmark = pytest.mark.integration


def owner(database):
    identity = str(uuid4())
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO sessions(id,token_hash) VALUES(%s,%s)",
            (identity, hashlib.sha256(identity.encode()).hexdigest()),
        )
    return identity


def proposal(repository, identity, trip, day=3):
    return repository.propose(
        identity,
        trip.id,
        trip.version,
        [{"kind": "move", "entryId": "tour", "day": day, "slot": "morning"}],
        load_catalog([entry.item for entry in trip.snapshot.entries]),
    )[0]


def test_concurrent_same_request_commits_one_version_and_replays(database):
    repository = TripService(database)
    identity = owner(database)
    trip = repository.create(identity, snapshot())
    proposal_id = proposal(repository, identity, trip)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                repository.mutate, identity, trip.id, 1, "same", "apply", proposal_id
            )
            for _ in range(2)
        ]
        results = [future.result(timeout=15) for future in futures]
    assert results[0] == results[1]
    assert results[0].version == 2
    assert results[0].snapshot.entries[1].day == 3
    with database.transaction() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM trip_versions").fetchone()[
                "n"
            ]
            == 2
        )
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        repository.mutate(identity, trip.id, 2, "same", "restore", 1)


def test_ownership_expiry_and_receipt_replay_do_not_bypass_access(database):
    repository = TripService(database)
    identity, stranger = owner(database), owner(database)
    trip = repository.create(identity, snapshot())
    proposal_id = proposal(repository, identity, trip)
    for operation in [
        lambda: repository.get(stranger, trip.id),
        lambda: repository.mutate(stranger, trip.id, 1, "try", "apply", proposal_id),
        lambda: repository.reject(stranger, trip.id, proposal_id),
    ]:
        with pytest.raises(DomainError, match="NOT_FOUND"):
            operation()
    repository.mutate(identity, trip.id, 1, "accepted", "apply", proposal_id)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE trips SET expires_at=clock_timestamp()-interval '1 second' "
            "WHERE id=%s",
            (trip.id,),
        )
    with pytest.raises(DomainError, match="NOT_FOUND"):
        repository.mutate(identity, trip.id, 1, "accepted", "apply", proposal_id)


def test_stale_proposals_restore_and_rejection_keep_full_versions(database):
    repository = TripService(database)
    identity = owner(database)
    trip = repository.create(identity, snapshot())
    first, second = (
        proposal(repository, identity, trip),
        proposal(repository, identity, trip, 4),
    )
    applied = repository.mutate(identity, trip.id, 1, "apply", "apply", first)
    with pytest.raises(DomainError, match="STALE_VERSION"):
        repository.mutate(identity, trip.id, 1, "stale", "apply", second)
    restored = repository.mutate(identity, trip.id, 2, "restore", "restore", 1)
    assert restored.version == 3
    assert restored.snapshot == trip.snapshot
    assert applied.snapshot != restored.snapshot
    rejected = proposal(repository, identity, restored)
    repository.reject(identity, trip.id, rejected)
    repository.reject(identity, trip.id, rejected)
    assert repository.get(identity, trip.id) == restored
    with pytest.raises(DomainError, match="INVALID_PROPOSAL"):
        repository.mutate(identity, trip.id, 3, "reject-bypass", "apply", rejected)


def test_missing_bound_catalog_cannot_be_reconstructed_from_proposal(database):
    repository = TripService(database)
    identity = owner(database)
    trip = repository.create(identity, snapshot())
    proposal_id = proposal(repository, identity, trip)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE proposals SET catalog_snapshot='[]' WHERE id=%s", (proposal_id,)
        )
    with pytest.raises(DomainError, match="INVALID_PROPOSAL"):
        repository.mutate(identity, trip.id, 1, "missing-catalog", "apply", proposal_id)
    assert repository.get(identity, trip.id).version == 1


def test_persisted_can_apply_is_not_authority(database):
    repository = TripService(database)
    identity = owner(database)
    trip = repository.create(identity, snapshot())
    proposal_id = proposal(repository, identity, trip)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE proposals SET draft=jsonb_set(draft,'{budget,knownMinor}','1') "
            "WHERE id=%s",
            (proposal_id,),
        )
    with pytest.raises(DomainError, match="INVALID_PROPOSAL"):
        repository.mutate(identity, trip.id, 1, "tamper", "apply", proposal_id)
    assert repository.get(identity, trip.id).version == 1
    with database.transaction() as connection:
        assert (
            connection.execute(
                "SELECT count(*) AS n FROM mutation_receipts"
            ).fetchone()["n"]
            == 0
        )
