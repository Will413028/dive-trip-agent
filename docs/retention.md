# Local retention operations

## Scope and guarantees

This is a local synthetic-data portfolio, not a public deployment. No system scheduler
is installed by the application. Read-time expiry is immediate; physical deletion
requires a running cleanup process. A stopped/sleeping host cannot guarantee a wall-clock
deletion deadline. Never advertise “all data is automatically deleted at exactly 30 days”.

- Product trip/session expiry is fixed at creation + 30 days; reads do not extend it.
- Each pass deletes at most 100 expired trips, with their versions, proposals, receipts,
  events, model-call records, invocations and ADK sessions/events in the same per-trip transaction.
- Running leases or worker locks defer deletion. Failures roll back that trip, not earlier
  trips already completed in the pass. Retrying is safe. Never kill unrelated workers to clear locks.
- At most 100 empty expired owners are then removed. Owners with unexpected ADK sessions/events
  are protected for investigation and excluded before pagination; they cannot block later owners.
- At most 1,000 quota receipts are compacted per pass. Eligibility: receipt is at least 30 days
  old, its lease expired, its Taipei day is past, its owner is absent/expired, and no invocation
  references it. Until then, metadata survives trip deletion to preserve quotas and replay fences.
- Compaction atomically deletes identifiers (owner/IP digest/request/payload hash/run ID) and
  adds only day, reservation count, charged USD microdollars and unknown-usage count to daily totals.
  Unknown usage retains its conservative charge. The quota global lock serializes settlement,
  admission and compaction. Late settlement of an already compacted receipt fails closed.
- Identifier-free daily totals older than 90 Taipei calendar days are removed. Unreferenced
  quota lock buckets are also removed, without changing the permanent global lock.

The receipt's 30-day period starts at its own reservation, not the owner's creation. An
expired owner's quota metadata may therefore outlive the trip; it never contains chat content.
Busy workers, protected orphan data, errors and backlogs can delay physical cleanup. Monitor
the remaining counts rather than treating a successful invocation as “nothing remains”.

## Commands

Run from the project checkout with the pinned Node toolchain and the dedicated Compose
PostgreSQL running. Start the normal workbench once to apply migrations through 009.
The cleanup command never creates schemas, runs migrations or reads an environment file.
It accepts only `workbench_demo` or `workbench_live` in the dedicated loopback `dive_trip_test` DB.
Since the grounded-answer cutover, `workbench_live` is historical read-only:
`--apply` (with or without `--watch`) is rejected before DB discovery/connection.
Only its dry-run counts remain available; no retention command may remove its
pending proposal or retained accounting evidence.
It does not accept a DB URL, arbitrary schema, injected time or provider credential.

```sh
# Read-only counts. Default; does not delete data.
pnpm data:expire --schema=workbench_demo

# Destructive: one bounded pass, only after approving the target/preview.
pnpm data:expire --schema=workbench_demo --apply

# Destructive foreground scheduler: first pass now, then one hour AFTER each pass completes.
pnpm data:expire --schema=workbench_demo --apply --watch
```

Never replace the demo schema with `workbench_live` for apply. Never run apply merely
to test the script against existing demonstrations; integration tests use fresh isolated schemas.
`--watch` requires `--apply`. SIGINT/SIGTERM stop further passes and allow current bounded
work to finish. Passes within one process do not overlap. Separate processes are safe under
DB locks but waste work; operate one scheduler per schema. An error prints only
`RETENTION_FAILED`, exits nonzero, and requires investigation/restart. No prompt, token,
connection string or individual owner/run ID is logged.

Each applied pass prints deletion/compaction counts, busy-trip count and remaining expired
trip/session/eligible-receipt counts. Persistent remaining data requires investigation:
check live leases, schema version, orphan ADK data and backlog. The watch process is not
installed or enabled automatically; no launchd/cron or public endpoint is created.

## Deployment / backups / rollback

No backup, cloud deployment or system job is configured by this project. Before a public
release, provide a supervised scheduler, failure/backlog alerting, throughput sizing and
a documented backup policy. Backups must expire within 30 days, must not be exposed through
the app, and a restore must reapply expiry/deletion decisions before serving traffic. This
restore procedure is a release gate, not an implemented claim. External saved pages,
browser tabs and copies sent to third parties cannot be remotely erased.

Rollback: stop the foreground scheduler first. Disable cleanup entrypoints while retaining
009 and all existing data/totals. Never reverse compaction or delete totals to reset quotas.
Deleted content and compacted receipt identifiers cannot be reconstructed by this application.
Do not revert to a binary that rejects the newer migration or ignores accumulated costs.

## Validation

Run integration tests alone against the dedicated DB, then build and browser tests;
concurrent suites contend on the SDK schema initialization lock. Tests cover repeated and
concurrent compaction, unknown-cost preservation, aggregation rollback, current-day/live-owner
protection, empty-owner cleanup, daily-budget totals and orphan-pagination progress. Real ADK
deletion, worker fencing and cross-schema rollback are in `tests/integration/retention.test.ts`.
