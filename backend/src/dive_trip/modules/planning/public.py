"""Transaction-scoped planning gates for application use cases."""

from typing import Any

from psycopg import Connection

from dive_trip.platform.errors import DomainError


def require_manual_proposal(
    connection: Connection[dict[str, Any]], proposal_id: str
) -> None:
    if (
        connection.execute(
            "SELECT id FROM agent_runs WHERE proposal_id=%s", (proposal_id,)
        ).fetchone()
        is not None
    ):
        raise DomainError("RUN_STATE_CONFLICT")
