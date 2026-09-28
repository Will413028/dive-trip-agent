# Local retention operations

## Python／Temporal cleanup

The default launcher uses Python／Temporal; cutover evidence is tracked in the implementation plan.
User-approved deletion is a persistent operation: return `202 {status:"deleting"}`
after fencing access to the trip and shares; report `deleted` only after Temporal
execution/history reads return not-found and product content is removed. Delete RPCs
are asynchronous, so an ACK alone is insufficient. The application refuses to claim
completion when Temporal history or visibility archival is enabled. See the
[Temporal API contract](https://github.com/temporalio/api/blob/master/temporal/api/workflowservice/v1/service.proto).

Pending jobs survive owner expiry and retain only identifiers needed for cleanup.
Completed jobs immediately clear workflow IDs. Their minimal status receipts serve
the still-valid owner, then become eligible for cleanup once the owner expires or
no longer exists; pending jobs are never removed by that cleanup. Processing is
bounded to 100 due jobs and 1,000 due completed receipts per pass, with persisted
backoff. Quota receipts retain the existing accounting policy. The worker schedules
expired trip/owner intents, then purges content, removes empty expired owners and
compacts eligible quota receipts without dropping unknown charges.

The retired ADK schema-v1 erasure adapter preserves the existing demo deletion
contract without loading or running an ADK agent. Its session/history erasure and
product deletion share the final product transaction; SDK invocation/schema locks
and version checks reject unsafe cleanup. Unexpected orphan sessions/events protect
their owners before bounded pagination. The cleanup entry permits only
`workbench_demo` and newly owned `python_test_<uuid>`/`e2e_<uuid>` schemas; historical
evaluation `test_<uuid>` schemas and `workbench_live` are rejected before DB access.
Original claims, reports and retained evaluation evidence are outside this path.

## Scope and operations

This is a local synthetic-data portfolio, not a public deployment. Read-time expiry
is immediate; physical deletion requires a running worker. A stopped host cannot
guarantee a wall-clock deletion deadline. Product trip/session expiry is creation
+ 30 days and reads do not extend it.

The supervised Python worker performs a bounded cleanup pass, then waits five
seconds. Each pass requests up to 100 expired-trip deletion jobs, processes up to
100 due jobs, removes up to 100 empty expired owners and compacts up to 1,000
eligible quota receipts. Job failures preserve progress and retry with persisted
backoff. A loop failure exits the worker; the local supervisor stops the remaining
stack instead of leaving an apparently healthy Web with no cleanup worker.

Quota compaction requires a receipt at least 30 days old, an expired lease, a past
Taipei day, absent/expired owner and no invocation reference. It removes identifying
metadata and adds reservation count, charged microdollars and unknown count to
daily totals. Unknown retains its conservative charge. Identifier-free totals
older than 90 Taipei days expire. Deleting a trip never resets quota.

```sh
# Read-only backlog; no migration, Temporal connection or deletion.
pnpm data:expire --database-port <dedicated-loopback-PostgreSQL-port>
```

The command accepts only `workbench_demo` and prints expired trip/session and
pending deletion counts. Cleanup is owned by the running Python worker. The old
Node `--apply`/`--watch` entry refuses before DB discovery; its historical read-only
preview remains available to existing audit tooling. Neither path may mutate
`workbench_live` or protected evaluation schemas. No hosted scheduler, public
cleanup endpoint or secret loader is configured.

A successful pass does not imply an empty backlog. Check pending jobs, leases,
Temporal availability, archival configuration and protected ADK orphans. Do not
kill unrelated workers or clear protected history to make cleanup pass.

## Backup and restore

Keep the PostgreSQL and Temporal stores paired. Stop ingress and workers and wait
for bounded shutdown before backup; retain immutable artifact and migration
identities. Pre-cutover backups also include the legacy demo ADK schema. Backups
must remain private and expire within 30 days; hosted encryption, automated expiry,
RPO/RTO and restore reconciliation are not configured or accepted.

Never revive deleted content, revoked shares or old quota by blindly restoring an
older snapshot. Restore to an isolated target, reconcile subsequent deletion,
revocation and accounting decisions, and verify both stores before serving. If
reconciliation is incomplete, keep the restored service closed. Do not reset
Temporal binding or delete quota to force a restore.

## Verification

The backend suites cover durable deletion, immediate access fencing, worker restart,
Temporal RPC failure, preserved accounting, owner expiry, legacy schema locks and
orphan protection. The browser suite checks deletion status after reload and
share/trip inaccessibility. Exact completed commands and limitations live in
[architecture-refactor](architecture-refactor.md) and [release evidence](release-evidence.md).
