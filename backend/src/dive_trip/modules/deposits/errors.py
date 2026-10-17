"""Deposit errors the caller can act on, typed so HTTP needs no list of codes."""

from dive_trip.platform.errors import DomainError


class DepositConflict(DomainError):
    """The booking's current state refuses the request (taken name, closed attempt,
    settlement no longer open); the code says which."""
