"""Atomic provider admission and private usage; this module cannot generate text."""

import time
from datetime import datetime
from typing import Any, Literal

from dive_trip.modules.catalog.public import load_catalog
from dive_trip.modules.identity.public import require_owner
from dive_trip.modules.planning import transactions as planning
from dive_trip.modules.planning.evidence import Binding, hash_tuple
from dive_trip.modules.trips import transactions as trips
from dive_trip.modules.usage import transactions as usage
from dive_trip.modules.usage.public import (
    AdmissionClock,
    ModelUsageEvent,
    Policy,
    ProviderBinding,
    Reservation,
    Reserve,
    lock_global,
    reserve_in_transaction,
)
from dive_trip.platform.database import Database
from dive_trip.platform.errors import DomainError

from .confirmation import commit_confirmation
from .recovery import recover_expired


class AdmissionService:
    def __init__(
        self,
        database: Database,
        catalog: Any,
        *,
        evaluation_fault: Literal["catalog-timeout"] | None = None,
    ) -> None:
        self.database = database
        self.catalog = load_catalog(catalog)
        self.evaluation_fault = evaluation_fault

    def resume(
        self,
        binding: Binding,
        interrupt_id: str,
        accepted: bool,
        provider: ProviderBinding,
        ip_key: str,
        now: datetime,
        policy: Policy,
        previous_ip_key: str | None = None,
        *,
        event_request_id: str,
    ) -> dict[str, Any]:
        clock = AdmissionClock(now, time.monotonic())
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, binding.ownerId, lock=True)
            request_id = f"temporal-resume:{binding.runId}"
            payload_hash = hash_tuple([binding.runId, interrupt_id, accepted])
            mutation = trips.claim_receipt(
                connection, binding.ownerId, request_id, "apply", payload_hash
            )
            trip = trips.get_trip(
                connection, binding.ownerId, binding.tripId, lock=True
            )
            require_owner(connection, binding.ownerId, not_before=clock.effective())
            run = planning.require_decision(
                connection, binding.tripId, binding.runId, interrupt_id, accepted
            )
            usage.require_binding(connection, binding.runId, provider)
            key: list[object] = ["resume", binding.runId, interrupt_id]
            identity: list[object] = [provider.provider, provider.model]
            if provider.provider == "cloudflare":
                identity.append(provider.accountId)
            reservation, created = reserve_in_transaction(
                connection,
                Reserve(
                    ownerId=binding.ownerId,
                    ipKey=ip_key,
                    previousIpKey=previous_ip_key,
                    requestId="agent:" + hash_tuple(key),
                    payloadHash=hash_tuple([*identity, *key, accepted]),
                    logicalRunId=binding.runId,
                    maxCostMicros=0,
                    now=now,
                ),
                policy,
                clock,
            )
            if created != (run["decision"] is None):
                raise DomainError("ADMISSION_STATE_CONFLICT")
            row = (
                usage.create_invocation(
                    connection,
                    binding.runId,
                    reservation.reservationId,
                    "resume",
                    provider,
                    0,
                    reservation.expiresAt,
                )
                if created
                else usage.reservation_invocation(connection, reservation.reservationId)
            )
            if (
                str(row["run_id"]) != binding.runId
                or row["kind"] != "resume"
                or row["max_cost_micros"] != 0
            ):
                raise DomainError("ADMISSION_STATE_CONFLICT")
            clock.check(row["expires_at"])
            committed = commit_confirmation(
                connection,
                binding,
                trip,
                interrupt_id,
                accepted,
                request_id,
                payload_hash,
                mutation,
                event_request_id,
            )
            usage.settle_invocation(
                connection, row, binding.ownerId, 0, clock.effective()
            )
            clock.check(row["expires_at"])
        clock.check(row["expires_at"])
        return committed

    def start(
        self,
        owner: str,
        trip_id: str,
        request_id: str,
        message: str,
        base_version: int,
        provider: ProviderBinding,
        ip_key: str,
        max_cost: int,
        now: datetime,
        policy: Policy,
        previous_ip_key: str | None = None,
    ) -> tuple[Binding, dict[str, Any], bool]:
        clock = AdmissionClock(now, time.monotonic())
        trips.valid_ids(owner, trip_id)
        if type(max_cost) is not int or max_cost <= 0:
            raise DomainError("INVALID_ADMISSION")
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, owner, lock=True)
            trip = trips.get_trip(connection, owner, trip_id, lock=True)
            require_owner(connection, owner, not_before=clock.effective())
            recover_expired(connection, owner, trip_id)
            run, created = planning.start_run(
                connection,
                trip_id,
                trip.version,
                request_id,
                message,
                base_version,
                self.catalog,
                evaluation_fault=self.evaluation_fault,
            )
            run_id = str(run["id"])
            if not created:
                usage.require_binding(connection, run_id, provider)
            key: list[object] = ["start", trip_id, request_id]
            identity: list[object] = [provider.provider, provider.model]
            if provider.provider == "cloudflare":
                identity.append(provider.accountId)
            reservation, reserved = reserve_in_transaction(
                connection,
                Reserve(
                    ownerId=owner,
                    ipKey=ip_key,
                    previousIpKey=previous_ip_key,
                    requestId="agent:" + hash_tuple(key),
                    payloadHash=hash_tuple([*identity, *key, message, base_version]),
                    logicalRunId=run_id,
                    maxCostMicros=max_cost,
                    now=now,
                ),
                policy,
                clock,
            )
            if created != reserved:
                raise DomainError("ADMISSION_STATE_CONFLICT")
            if created:
                row = usage.create_invocation(
                    connection,
                    run_id,
                    reservation.reservationId,
                    "start",
                    provider,
                    max_cost,
                    min(run["lease_expires_at"], reservation.expiresAt),
                )
            else:
                row = usage.reservation_invocation(
                    connection, reservation.reservationId
                )
                if str(row["run_id"]) != run_id or row["kind"] != "start":
                    raise DomainError("ADMISSION_STATE_CONFLICT")
            clock.check(row["expires_at"])
            binding = Binding(
                ownerId=owner, tripId=trip_id, runId=run_id, baseVersion=base_version
            )
        clock.check(row["expires_at"])
        return binding, row, created

    def account(
        self, binding: Binding, admission_id: str, event: ModelUsageEvent | str
    ) -> bool:
        trips.valid_ids(admission_id)
        with self.database.transaction() as connection:
            lock_global(connection)
            require_owner(connection, binding.ownerId, lock=True)
            trips.get_trip(connection, binding.ownerId, binding.tripId, lock=True)
            require_owner(connection, binding.ownerId)
            run = planning.require_run(
                connection, binding.tripId, binding.runId, active=True
            )
            if run["base_version"] != binding.baseVersion:
                raise DomainError("RUN_STATE_CONFLICT")
            row = usage.invocation(connection, binding.runId, admission_id)
            usage.require_active(connection, row, binding.ownerId)
            recorded = (
                usage.record_start(connection, row, event)
                if isinstance(event, str)
                else usage.record_usage(connection, row, event)
            )
            usage.require_active(connection, row, binding.ownerId)
            return recorded

    def settle(
        self, binding: Binding, admission_id: str, actual: int | None, now: datetime
    ) -> Reservation:
        """Trusted finalizer; unknown usage retains the original bound after expiry."""
        trips.valid_ids(admission_id)
        with self.database.transaction() as connection:
            lock_global(connection)
            run = planning.require_run(connection, binding.tripId, binding.runId)
            if (
                run["base_version"] != binding.baseVersion
                or trips.worker_owner(connection, binding.tripId) != binding.ownerId
            ):
                raise DomainError("ADMISSION_STATE_CONFLICT")
            row = usage.invocation(connection, binding.runId, admission_id)
            return usage.settle_invocation(
                connection, row, binding.ownerId, actual, now
            )
