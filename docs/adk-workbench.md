# ADK + AG-UI workbench integration

Local, synthetic-data implementation. Gemini is disabled. This is not a booking
service, a general-language model demo, or a deployable public configuration.

## Execution contract

- The official AG-UI `HttpAgent` posts only the current user message, or one
  explicit confirmation. Client history, state, tools and owner are not trusted.
- Product PostgreSQL stores logical runs, request hashes, decisions and committed
  AG-UI events. A separate invocation ID identifies each start/resume stream.
  Its terminal event and product run status commit in one transaction.
- Google ADK TypeScript `Runner` performs the real model/tool loop. The model is
  a deterministic `BaseLlm`; the tool uses native `requireConfirmation`.
- The one native loop emits strict `AnswerPlan` intent/reference data. Durable
  server-owned tool events provide Evidence; the compiler creates versioned
  `AcceptedAnswer` values. Native callbacks commit the compiled projection in
  ADK stateDelta. Public SSE and refresh expose only `dive_trip.answer.v1` and
  fixed progress events, never model prose, tool arguments or private results.
- Product persistence validates the projection before ACK/publication. Proposal
  binding must commit before its awaiting-confirmation answer is published;
  success requires a valid current-phase answer. Identical answer IDs replay
  the saved value, not a re-render against a new catalog or template.
- Each invocation runs in a supervised Node child process. The child receives
  configuration over IPC, without inherited credentials or env files, and waits
  for the parent's persistence ACK before emitting the next event. Timeout,
  cancellation or a persistence failure terminates the child; its exit releases
  SDK connections without accessing private ORM internals.
  The parent also waits for its in-flight persistence hook to settle before
  returning. Hooks must remain bounded; current product SQL uses finite pool
  and statement timeouts. Cancellation does not roll back already committed data.
- ADK `DatabaseSessionService` uses a dedicated `<product_schema>_adk` schema.
  SDK tables must never be created in the product schema's `sessions` table.
  MikroORM 7.2.1 nevertheless introspects other schemas during bootstrap;
  its name-to-regclass lookup can race a concurrent DROP/RENAME. SDK init and
  this project's ephemeral schema cleanup/rename share one database advisory
  lock. Model execution does not hold that lock. Uncoordinated external DDL
  is not supported by this local test setup; no SDK files were patched.
- The model only proposes changes. The parent verifies them as `actor=agent`,
  freezes the catalog and binds the proposal to the native interrupt. Approval
  performs the existing product transaction first; the ADK tool only receives
  the authenticated committed result. Rejection uses the same decision path.
- Agent apply/reject verifies the run lease, decision and proposal binding
  inside the trip transaction. Card endpoints cannot bypass a chat confirmation.
  Retries never automatically repeat an interrupted ADK invocation.
- Confirmation completion has no generative work: `afterToolCallback` compiles
  the authenticated receipt into the same durable native tool-result event.
  `skipSummarization` plus public `InvocationContext.endInvocation` prevents an
  acknowledgement model call. ADK 2.1 confirmation preprocessing ignores
  `skipSummarization` alone; an executable native probe covers both decisions.
- Generation capability is start-only. Resume retains provider/model/account
  identity but receives no credential, synthetic transport or generation budget.
  `ReceiptOnlyModel` fails locally if ADK unexpectedly tries to generate; native
  confirmation processing remains owned by the same framework. Zero-cost
  admission retains owner/TTL, rate, concurrency and idempotency checks.

## Recovery semantics

`GET /api/trips/:id/runs` restores conversation, run status and proposal/base.
It is read-only with respect to Agent execution, but marks expired leases
interrupted for current-contract runs, with a fixed failure projection. Refresh
never invokes a model. Event replay does not restart ADK. Historical contract-0
runs and the retained `workbench_live` remain read-only: no lease recovery,
resume, automatic approval/rejection, or raw-prose fallback. Only the independent
`workbench_demo` is admitted by the local launcher during this cutover.

The history viewport reveals the latest accepted answer once per answerId,
including after a reload; a hidden mobile panel waits until layout is visible.
Repeated reads of the same answer preserve the user's history scroll. This
changes only navigation: older pending proposals keep their original immutable
wording, while the final receipt is no longer hidden below them by default.

An awaiting confirmation survives a server restart. After a decision is claimed,
a crash is treated conservatively: the product may have committed even when
ADK completion did not. Read the authoritative trip version; do not infer that
an interrupted/failed run means a rollback, or automatically resume the same
ambiguous invocation. The deterministic product receipt prevents duplicate
versions, but is not an exactly-once guarantee for arbitrary external effects.
An applied/rejected decision's frozen receipt is shown separately from an
unfinished Agent round. A later trip version cannot change that receipt.

## Fixed scripts and limits

- `第二天下午留白`: proposes removing day-two afternoon activities, including
  locked ones so that domain validation can show the conflict rather than
  silently bypassing it. No-op when none exist.
- `人數未定`: fixed clarification question; no mutation.
- `查詢目的地` / `試算目前預算`: invoke read-only ADK tools; display only compiled,
  evidence-bound answers with mandatory unknown-cost and DEMO disclosures.
- `把行程改為悠閒`: validate a requirements change, then request native confirmation.
- Other text: explains the supported demo scope; no invented proposal.

Runtime accepts only the dedicated loopback `dive_trip_test` database. Each
invocation has a 60-second parent deadline and a 55-second ADK deadline, with
at most seven model calls and six tools across a logical run. A confirmation
receipt adds zero model calls/tools; no slot is reserved for model narration.
Strict whole-candidate guards run before ADK tool
execution; the native `set_model_response` tool counts toward that same cap.
See [model adapter](model-adapter.md) for byte/token bounds and the
separately tested, still-disabled Gemini adapter. This is not Task 9's per-session quota,
provider spending reservation or public abuse protection.

The worker is launched from `src/agent/worker.ts` under the project working
directory. A standalone deployment bundle would need explicit worker packaging;
the local launcher is not a deployment artifact.

## Verification

Relevant tests: `tests/integration/run-store.test.ts`,
`tests/integration/agent-runtime.test.ts`, `tests/integration/chat-http.test.ts`,
and `tests/e2e/chat.spec.ts`. Run the existing README commands; do not run Next
build/dev/start and browser tests simultaneously against the same build directory.

## References

- [ADK TypeScript native confirmation example](https://github.com/google/adk-docs/blob/main/examples/typescript/snippets/agents/workflow-agents/hitl_confirmation_agent.ts)
- [AG-UI event and interrupt protocol](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/concepts/events.mdx)
- Version-specific evidence is the installed ADK 2.1.0 / AG-UI 1.0.0 source and
  executable tests, not an assumption from a language-support summary table.
