# ADK TypeScript + AG-UI capability probe

## Outcome

2026-09-21: the offline probe passed approval/rejection across real process restarts
using ADK's native confirmation and PostgreSQL session service. This is not a
live Gemini result or a completed product UI. A local browser probe is available.

Pinned stack: `@google/adk@2.1.0`, `@ag-ui/core@1.0.0`,
`@ag-ui/client@1.0.0`, `@mikro-orm/postgresql@7.2.1`, Node 26.8.1.

## What actually runs

`HttpAgent → localhost HTTP/SSE → small application protocol adapter → Runner →
LlmAgent + FunctionTool(requireConfirmation: true) → DatabaseSessionService`.

The model is a deterministic `BaseLlm` fixture. ADK performs the actual model/tool
loop and confirmation handling. Only ADK event → AG-UI event and AG-UI resume →
ADK function response translation is application code. No custom session store,
confirmation execution engine, or duplicate receipt store was substituted.

The tool increments an ADK session-state counter. The test receives a pending
AG-UI interrupt with counter zero, sends SIGKILL to the worker, starts a different
PID, answers the same interrupt, and checks the persisted counter. It kills and
starts another worker before replaying the same approval. Rejection follows the
same path. A third test rejects unknown confirmations and missing sessions.
A fourth test rejects foreign browser origins and malformed session identifiers.
A fifth test stops the launcher before the backend is ready and verifies that
the child process exits and the frontend never starts after cancellation.
The restart tests also verify the read-only session endpoint restores pending,
approved and rejected states from PostgreSQL.

## Verified boundary

- Approval after restart increments the counter once; rejection leaves it zero.
- Sequential duplicate confirmation after another restart does not increment it again.
- A rejected confirmation remains rejected when approved after a further restart.
- AG-UI `RUN_STARTED`, tool events, `STATE_SNAPSHOT`, and interrupt/success outcomes
  travel through the real SDK HTTP client; outgoing events pass the AG-UI schema.
- Existing 215 domain tests, typecheck, lint, and strict frozen-lockfile install pass.
- Five offline integration/lifecycle tests pass; the probe UI also bundles with
  Vite in memory (`build.write=false`), without generating deployment artifacts.

Not verified: real Gemini behavior; arbitrary mid-tool crash recovery; two concurrent approvals;
external side effects or exactly-once writes to the application's trip tables;
production ownership/authentication; upstream model streaming failures.

The endpoint is **test-only**, loopback-only, with a fixed synthetic user, no
credentials and no real trip changes. Do not deploy it or reuse its identity model.
The browser stores only the thread ID in localStorage, then restores the pending
interrupt and decision from a read-only server endpoint. The test does not claim recovery from every
instruction boundary in arbitrary workflows.

## Browser probe

```sh
docker start dive-trip-adk-spike
pnpm dev:probe
# Open http://127.0.0.1:4317/
```

This uses the already-installed Vite only to serve a small test UI under
`tests/probe-ui/`. It does not replace the planned Next.js product, install new
packages, load `.env` files, or enable a real model. Ctrl-C closes both frontend
and backend; stop the dedicated database separately when no longer needed.

Chrome manual verification on 2026-09-21:

- Generate proposal → pending card with count 0 → refresh restores pending.
- Approve → count 1 → refresh retains approved/count 1.
- New proposal → terminate backend → refresh-state button shows HTTP 502 and
  disables approve/reject, rather than reporting success.
- Restart frontend/backend processes → refresh restores the same pending thread
  from PostgreSQL → reject → refresh retains rejected/count 0.
- Desktop layout inspected. Mobile viewport and automated browser regression
  coverage remain unverified. Event log is tab-local and explicitly not history replay.

Only loopback Host and the probe's browser Origin are accepted. This is not a
substitute for product authentication: all probe sessions have one synthetic owner.

## Compatibility findings

- Installed ADK 2.1.0 exports `DatabaseSessionService`, `ResumabilityConfig`, and
  `FunctionTool.requireConfirmation`. Older documentation language-support tables
  are not sufficient evidence that TypeScript lacks these features.
- `@ag-ui/adk@0.0.2` is an HTTP client for the companion Python middleware, not a
  TypeScript backend adapter. With core 1.0 it fails at import because it requests
  `AgentCapabilitiesSchema` from the root export, which moved to `/schemas`.
  It was removed; the probe uses the official generic `HttpAgent` instead.
- ADK root declarations reference optional packages. Development dependencies for
  Express types, Cloud Storage, MCP and OpenAPI are installed to preserve full
  typechecking, not to enable those services. No `skipLibCheck` was introduced.
- `pnpm-workspace.yaml` explicitly denies dependency lifecycle scripts for genai,
  protobufjs, ssh2 and cpu-features. The verified path works without them; SSH and
  sandbox/container tools are outside this probe.

## Reproduce

From the project directory, with the existing local `postgres:16-alpine` image:

```sh
# First time only; dedicated synthetic database, random loopback host port.
docker run -d --name dive-trip-adk-spike --pull never \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=dive_trip_adk_spike \
  -p 127.0.0.1::5432 postgres:16-alpine
# If the container already exists but is stopped:
docker start dive-trip-adk-spike
pnpm test:adk
pnpm test:unit
pnpm typecheck
pnpm lint
docker stop dive-trip-adk-spike
```

The test discovers only this container's published port and refuses a database
URL outside loopback or the dedicated database name. Sessions use random IDs.
Synthetic database data is retained; tests do not drop databases or touch other
containers. The trust-auth setup is for local testing only, never production.

## Sources

- [ADK JS source](https://github.com/google/adk-js)
- [ADK confirmation documentation](https://adk.dev/tools-custom/confirmation/)
- [AG-UI ADK integration README](https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/adk-middleware/typescript/README.md)
- Installed SDK declarations and executable tests are the version-specific evidence.
