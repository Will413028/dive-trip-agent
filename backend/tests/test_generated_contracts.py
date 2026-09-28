from pathlib import Path

from dive_trip.bootstrap.contracts import generate


def test_committed_frontend_contracts_match_backend_schemas():
    artifact = Path(__file__).resolve().parents[2] / "src/contracts/generated.ts"
    assert artifact.read_text() == generate(), "Run pnpm contracts:generate"
