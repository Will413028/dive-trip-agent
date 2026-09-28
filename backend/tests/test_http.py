import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_budget import snapshot

from dive_trip.bootstrap.api import create_app
from dive_trip.modules.catalog.public import load_catalog

pytestmark = pytest.mark.integration
ORIGIN = "http://localhost:3000"


def test_demo_routes_use_the_product_catalog_and_create_owned_trips(database):
    catalog = load_catalog(
        json.loads(
            (Path(__file__).resolve().parents[2] / "data/catalog.json").read_text()
        )
    )
    with TestClient(
        create_app(database, catalog, ORIGIN),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    ) as client:
        identities = set()
        for scenario in ("normal", "budget-conflict", "lookup-failure"):
            response = client.post("/api/demo", json={"scenario": scenario})
            assert response.status_code == 200
            trip = response.json()
            identities.add(trip["id"])
            assert client.get(f"/api/trips/{trip['id']}").json() == trip
            assert trip["snapshot"]["entries"][0]["locked"] == (
                scenario == "budget-conflict"
            )
            assert len(trip["snapshot"]["entries"]) == 3
        assert len(identities) == 3


def client_for(database):
    catalog = load_catalog([entry["item"] for entry in snapshot()["entries"]])
    return TestClient(
        create_app(database, catalog, ORIGIN),
        base_url=ORIGIN,
        headers={"Origin": ORIGIN},
    )


def test_http_manual_proposal_confirmation_restore_and_ownership(database):
    with client_for(database) as client:
        session = client.post("/api/session", json={})
        assert session.status_code == 200
        assert "HttpOnly" in session.headers["set-cookie"]
        assert "SameSite=lax" in session.headers["set-cookie"]
        trip = client.post(
            "/api/trips", json={"requirements": snapshot()["requirements"]}
        ).json()
        trip_id = trip["id"]
        response = client.post(
            f"/api/trips/{trip_id}/proposals",
            json={
                "baseVersion": 1,
                "changes": [
                    {
                        "kind": "add",
                        "entry": {
                            "id": "tour",
                            "catalogId": "tour",
                            "day": 2,
                            "slot": "morning",
                            "endDay": None,
                            "rooms": None,
                        },
                    }
                ],
            },
        )
        assert response.status_code == 200
        proposal = response.json()
        assert proposal["draft"]["budget"]["knownMinor"] == 100000
        assert proposal["draft"]["budget"]["withinBudget"] is None
        assert proposal["review"]["knownDeltaMinor"] == 100000
        assert proposal["review"]["differences"] == [
            {"path": "/entries/tour", "after": proposal["draft"]["next"]["entries"][0]}
        ]
        applied = client.post(
            f"/api/trips/{trip_id}/apply",
            json={
                "baseVersion": 1,
                "proposalId": proposal["proposalId"],
                "requestId": "apply",
            },
        )
        assert applied.status_code == 200
        assert applied.json()["version"] == 2
        restored = client.post(
            f"/api/trips/{trip_id}/restore",
            json={"baseVersion": 2, "targetVersion": 1, "requestId": "restore"},
        )
        assert restored.status_code == 200
        assert restored.json()["version"] == 3
        assert restored.json()["snapshot"]["entries"] == []
        with client_for(database) as stranger:
            stranger.post("/api/session", json={})
            assert stranger.get(f"/api/trips/{trip_id}").status_code == 404


def test_http_rejects_origin_body_size_and_duplicate_credentials(database):
    with client_for(database) as client:
        assert client.post(
            "/api/session", json={}, headers={"Origin": "https://attacker.invalid"}
        ).json() == {"error": "INVALID_ORIGIN"}
        assert client.post("/api/session", content="{}").json() == {
            "error": "INVALID_CONTENT_TYPE"
        }
        assert client.post(
            "/api/session",
            content="x" * 32769,
            headers={"Content-Type": "application/json"},
        ).json() == {"error": "BODY_TOO_LARGE"}
        assert client.post("/api/session", json={"actor": "user"}).status_code == 400
        client.post("/api/session", json={})
        token = client.cookies.get("dive_trip_session")
        duplicate = f"dive_trip_session={token}; dive_trip_session={token}"
        assert (
            client.post(
                "/api/trips",
                json={"requirements": snapshot()["requirements"]},
                headers={"cookie": duplicate},
            ).status_code
            == 404
        )
        response = client.get("/api/catalog")
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
