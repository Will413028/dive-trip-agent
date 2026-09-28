import time
from datetime import datetime

from dive_trip.modules.identity.public import require_owner
from dive_trip.modules.usage.public import (
    AdmissionClock,
    Policy,
    Reservation,
    Reserve,
    lock_global,
    reserve_in_transaction,
    settle_in_transaction,
)
from dive_trip.platform.database import Database


class Quota:
    def __init__(self, database: Database) -> None:
        self.database = database

    def reserve(self, input: Reserve, policy: Policy) -> tuple[Reservation, bool]:
        clock = AdmissionClock(input.now, time.monotonic())
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, input.ownerId, lock=True)
            require_owner(connection, input.ownerId, not_before=clock.effective())
            reservation, created = reserve_in_transaction(
                connection, input, policy, clock
            )
            if created:
                clock.check(reservation.expiresAt)
        if created:
            clock.check(reservation.expiresAt)
        return reservation, created

    def settle(
        self, reservation_id: str, actual: int | None, now: datetime
    ) -> Reservation:
        with self.database.transaction() as connection:
            return settle_in_transaction(connection, reservation_id, actual, now)
