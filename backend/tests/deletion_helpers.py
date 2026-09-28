"""Real deletion with short isolated-server ACK cadence, not disabled close checks."""

import asyncio

from dive_trip.platform.errors import DomainError

# Temporal 1.32 defaults this queue ACK interval to 30s. Deletion is asynchronous
# and waits for close-task acknowledgement; test deadlines remain unchanged.
DELETE_SERVER_ARGS = [
    "--dynamic-config-value",
    'history.transferProcessorUpdateAckInterval="1s"',
]


async def purge_eventually(worker, trip_id):
    async with asyncio.timeout(20):
        while True:
            try:
                await worker.purge(trip_id)
                return
            except DomainError as error:
                if error.code != "DELETION_PENDING":
                    raise
                assert worker.service.job(trip_id)["status"] == "deleting"
                await asyncio.sleep(0.1)
