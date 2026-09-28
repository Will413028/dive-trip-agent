from typing import Literal

from dive_trip.modules.catalog.public import CatalogItem
from dive_trip.modules.trips.public import Snapshot
from dive_trip.platform.errors import DomainError

DemoScenario = Literal["normal", "budget-conflict", "lookup-failure"]


def demo_snapshot(catalog: list[CatalogItem], scenario: DemoScenario) -> Snapshot:
    items = {item.id: item for item in catalog}
    if not all(identity in items for identity in ("stay", "tour", "transfer")):
        raise DomainError("DEMO_CATALOG_REQUIRED")
    return Snapshot.model_validate(
        {
            "requirements": {
                "destinationId": "xiaoliuqiu",
                "days": 4,
                "people": 2,
                "divers": 1,
                "startDate": None,
                "budgetMinor": 430000 if scenario == "budget-conflict" else 1000000,
                "lodgingPreference": "示範雙人房",
                "pace": "balanced",
            },
            "entries": [
                {
                    "id": identity,
                    "catalogId": identity,
                    "day": 1 if identity == "stay" else 2,
                    "slot": {
                        "stay": "evening",
                        "tour": "morning",
                        "transfer": "afternoon",
                    }[identity],
                    "endDay": 4 if identity == "stay" else None,
                    "rooms": 1 if identity == "stay" else None,
                    "locked": scenario == "budget-conflict" and identity == "stay",
                    "item": items[identity].model_dump(mode="json"),
                }
                for identity in ("stay", "tour", "transfer")
            ],
            "exclusions": [],
        }
    )
