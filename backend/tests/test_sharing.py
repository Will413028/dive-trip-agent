import hashlib

import pytest
from fastapi.testclient import TestClient
from test_budget import snapshot
from test_trip_transactions import owner

from dive_trip.application.sharing import SharingService
from dive_trip.application.trips import TripService
from dive_trip.bootstrap.api import create_app
from dive_trip.modules.catalog.public import load_catalog
from dive_trip.modules.identity.public import Sessions
from dive_trip.modules.sharing.public import hash_preview, preview_share
from dive_trip.modules.trips.public import Snapshot
from dive_trip.platform.errors import DomainError


def test_public_projection_redacts_private_and_unverified_catalog_text():
    raw = snapshot()
    catalog = load_catalog([entry["item"] for entry in raw["entries"]])
    raw["requirements"].update(
        startDate="2026-10-01", lodgingPreference="private lodging"
    )
    raw["exclusions"] = ["private exclusion"]
    raw["entries"][0]["item"]["title"] = "DEMO private historical contact"
    raw["entries"][0]["item"]["sources"][0]["label"] = "DEMO private source"
    raw["entries"][1]["item"]["price"].update(
        unitMinor=None, unknownReason="private price"
    )
    result = preview_share(Snapshot.model_validate(raw), catalog)
    wire = result.model_dump_json()
    assert "private" not in wire
    assert "startDate" not in wire
    assert result.entries[0].sources == []
    assert not result.entries[0].sourceVerified
    assert result.entries[1].price.unitMinor is None
    assert result.budget.unknownCount == 1
    assert result.budget.exclusionsCount == 1
    assert result.entries[2].sourceVerified
    assert result.entries[2].demo
    assert hash_preview(result) == hash_preview(result.model_copy(deep=True))


@pytest.mark.integration
def test_share_snapshot_hash_revoke_limits_and_ttl(database):
    identity = owner(database)
    trip = TripService(database).create(identity, snapshot())
    service = SharingService(database, [entry.item for entry in trip.snapshot.entries])
    preview = service.preview(identity, trip.id, 1)
    with pytest.raises(DomainError, match="SHARE_PREVIEW_CHANGED"):
        service.create(identity, trip.id, 1, "0" * 64)
    share = service.create(identity, trip.id, 1, preview["previewHash"])
    assert service.read(share["token"]).model_dump(mode="json") == preview["preview"]
    with database.transaction() as connection:
        row = connection.execute("SELECT * FROM trip_shares").fetchone()
        assert row["token_hash"] == hashlib.sha256(share["token"].encode()).hexdigest()
        assert share["token"] not in str(row)
    service.catalog = []
    assert service.read(share["token"]).model_dump(mode="json") == preview["preview"]
    with pytest.raises(DomainError, match="SHARE_PREVIEW_CHANGED"):
        service.create(identity, trip.id, 1, preview["previewHash"])
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.revoke(owner(database), trip.id, share["id"])
    service.revoke(identity, trip.id, share["id"])
    service.revoke(identity, trip.id, share["id"])
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.read(share["token"])
    fresh = service.preview(identity, trip.id, 1)
    for _ in range(19):
        last = service.create(identity, trip.id, 1, fresh["previewHash"])
    with pytest.raises(DomainError, match="SHARE_LIMIT"):
        service.create(identity, trip.id, 1, fresh["previewHash"])
    with database.transaction() as connection:
        connection.execute("UPDATE sessions SET expires_at=clock_timestamp()")
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.read(last["token"])


@pytest.mark.integration
def test_share_http_contract_and_owner_boundary(database):
    identity, token = Sessions(database).create()
    trip = TripService(database).create(identity, snapshot())
    catalog = [entry.item for entry in trip.snapshot.entries]
    app = create_app(database, catalog, "http://testserver")
    with TestClient(app, headers={"Origin": "http://testserver"}) as client:
        client.cookies.set("dive_trip_session", token)
        base = f"/api/trips/{trip.id}/shares"
        preview = client.post(f"{base}/preview", json={"version": 1}).json()
        response = client.post(
            base, json={"version": 1, "previewHash": preview["previewHash"]}
        )
        assert response.status_code == 200
        share = response.json()
        assert len(client.get(base).json()["shares"]) == 1
        client.cookies.clear()
        public = client.get(f"/api/shares/{share['token']}")
        assert public.json() == preview["preview"]
        assert public.headers["cache-control"] == "no-store"
        assert public.headers["x-robots-tag"] == "noindex, nofollow"
        assert client.get(base).status_code == 404
        assert client.post(f"{base}/{share['id']}/revoke", json={}).status_code == 404
        client.cookies.set("dive_trip_session", token)
        assert client.post(f"{base}/{share['id']}/revoke", json={}).status_code == 200
        assert client.get(f"/api/shares/{share['token']}").status_code == 404
