# ADK bounded tools and Gemini adapter

## Current cutover — 2026-09-27 (offline only)

The grounded-answer refactor is implemented. Remaining semantic-quality and
release work stays in the [release checklist](release-evidence.md#執行交接);
verification results remain scoped to their recorded revision.
Only `workbench_demo` may cut over; `workbench_live` and its undecided legacy
proposal remain read-only. The launcher rejects live options before migration,
ingress or credentials. HTTP admits fixture/synthetic contexts only. Historical live evidence remains private and does not establish this contract's quality.

One native ADK agent still owns the loop and confirmation. Its outputSchema is
the strict AnswerPlan union, with the SDK's `set_model_response` fallback; the
guard validates that final call before ADK rewrites it to JSON. It counts toward
the existing six-tool/seven-model limit. No formatter model, retry or second loop
is added. Thought parts, mixed final calls and free final prose fail closed.

`afterToolCallback` attaches a server-created `answerEvidenceRef`. Evidence is
reconstructed only from bound durable tool events. `afterModelCallback` compiles
the accepted projection and stores it in the same native event's stateDelta.
After a committed human decision, `afterToolCallback` instead compiles the
fixed receipt in the native tool-result event. Public `InvocationContext.endInvocation`
and `skipSummarization` end that phase without another model or final-tool call.
The latter flag alone is insufficient in ADK 2.1 confirmation preprocessing;
both native in-memory and cross-process accept/reject probes cover termination.
Provider identity (kind/model/account) is separate from generation capability.
Only start receives a credential; resume uses `ReceiptOnlyModel`, whose generation
and connection methods fail locally. It cannot instantiate a provider or emit
model accounting. Migration 013 permits zero-cost continuation reservations;
rate, concurrency, owner/TTL and immutable provider binding still apply.
The worker publishes only that immutable projection and static tool progress;
IPC and HTTP validate it again, and product persistence precedes ACK/public SSE.
Neither model prose nor raw tool JSON is a public alternate channel.

Public `CUSTOM: dive_trip.answer.v1` carries schema/template versions, answerId,
runId and typed data. Current/candidate scope, source provenance, DEMO, unknown
and excluded costs are server-selected disclosures. Post-decision answers can
only reference the committed receipt. If the transaction commits but the turn
fails, existing product receipts reconstruct a fixed failure+committed result,
without applying again or asking the model. Replay uses the stored projection,
not today's catalog or templates. Old contract rows are never resumed/regraded.

The Next workbench defaults to `FixtureModel`. Ordinary tests use fixed offline
scenarios, an exact synthetic credential and a bootstrap that replaces fetch
without a native-network fallback. Public regression vectors are de-identified
and cannot prove live quality, remaining quota or original run provenance.
Original claims/reports/usage stay in ignored local storage. Real-model entries
require separate explicit bounded authorization and a fresh original-history
check; public fixtures must never reset quota. Current release status is in
[release evidence](release-evidence.md).

## Answer design and rollback

The model produces strict intent/reference data, never public amounts, saved-state
claims or arbitrary text/HTML/Markdown. Server-owned Evidence binds owner/trip/run,
snapshot/version, tool call and current/candidate/committed scope; reference IDs
are not authorization. The compiler resolves those references into AcceptedAnswer.
Required evidence and disclosures come from the answer type, not only the subset
the model selected. A partial comparison cannot establish the cheapest option.
Classifying a turn as general chat does not open a free-prose bypass.

This replaces free prose plus post-hoc checks, including correct cards beside
unverified prose. It trades open-ended expression for closed answer types and
versioned templates; it does not establish source truth or semantic task success.
The bounded ADK loop remains because compound requests need tool exploration.
Reconsider a fixed workflow if same-scenario task evidence favors it, rather
than treating a prose error as evidence that all dynamic tool choice must go.

Durable native events supply evidence; no second mutable evidence ledger is
maintained. Existing UUIDs, request hashes, answer uniqueness, trip transactions
and leases protect persistence/replay. Native stateDelta and product run events
hold the same immutable projection for their distinct recovery/delivery roles.
External side effects or cross-service delivery would require a fresh transaction
and outbox assessment, not a claim of arbitrary exactly-once execution.

If the answer contract fails, disable Agent execution and retain read-only or
already validated manual operations. Never fall back to unvalidated model prose,
resume legacy proposals, regrade old reports or rewrite unknown accounting.
Future post-decision exploration needs a new run with explicit generation
capability; it cannot silently reuse the receipt-only continuation.

## Framework and provider

Google ADK TypeScript 2.1.0 owns the model/tool loop, native confirmation and
PostgreSQL sessions. `GuardedModel` is an ADK `BaseLlm` decorator, not a second
runner. `createGeminiProvider` subclasses ADK `Gemini`, using its request/response
conversion and the locked transitive `@google/genai` 2.23.0. No new dependency.

The adapter targets `gemini-3.1-flash-lite`, Developer API only, pinning the client
endpoint to `https://generativelanguage.googleapis.com` and API version `v1beta`
against SDK environment/global/request URL overrides, with an explicit
caller-supplied key and no Vertex/Interactions fallback. Construction is not an
authorization to use that key. Future launch wiring must remain fail-closed.
The [model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
lists function calling, structured output, 1,048,576 input and 65,536 output
tokens; this application deliberately uses much smaller output limits.

Checked 2026-09-22: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite)
lists free-tier input/output; paid standard text input is USD 0.25/M tokens and
output including thinking USD 1.50/M. These are reference prices, **not a paid
budget approval**. Free-tier content may improve Google products; use synthetic
data only. [Actual rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
depend on the project in AI Studio, not a universal quota per API key. Google's
daily reset is Pacific time; the product ledger uses Asia/Taipei and does not
replace Google's limits. No search, maps grounding, code execution or URL tool
is enabled by this application.

## Tools and authority

Four read-only ADK `FunctionTool`s use frozen server-selected inputs:

- `find_destinations`: supported destinations and catalog counts, not availability.
- `find_items`: catalog lookup, at most 20 returned items, preserving price and
  source/DEMO provenance; explicit omitted counts.
- `calculate_budget`: server snapshot only; TWD minor units, unknown/excluded
  costs retained, not a model-provided total.
- `validate_changes`: domain validation as `actor=agent`, no mutation.

`propose_changes` is the native human-confirmation gate. The latest validation
attempt must have completed successfully with the matching `validationId`;
a newer failed or unfinished attempt also invalidates older candidates. Both
confirmation and answer reconstruction use the same durable-history parser.
`validate_changes` accepts strict
requirements/add/remove/move/replace/rooms changes, never lock/unlock,
actor, a client snapshot, prices or arbitrary item objects. The authenticated
product transaction still performs the actual mutation before ADK resumes.
One proposal per logical run, emitted alone; no parallel proposals.

Agent `requirements.value` is a nonempty partial patch: omitted fields retain
the trusted run-base values, explicit `null` clears only nullable fields, and
present `undefined`, unknown fields and invalid dates are rejected without
coercion. Multiple requirements changes accumulate in array order. Both tools
use the same expansion before complete domain validation; the worker emits
canonical full replacements to IPC, and proposals/versions retain the full
contract. Resume uses the original bound snapshot/catalog, not the newly applied
version. Full requirements remain a valid nonempty patch, but legacy proposal
`changes` arguments and pre-contract ADK sessions are not executable. The manual HTTP proposal
API still requires full requirements; this change does not loosen that API.
Nonempty patches are enforced at runtime and described to the model (the custom
Zod refinement is not a JSON Schema constraint). Human confirmation, locks,
budget/capacity checks and model-call limits are unchanged.

Budget tool results also carry server-computed `budgetConstraint` and
`priceDisclosure`. The lower bound prices the **original locked entries** using
the current/candidate requirements, never an illegally removed or replaced
locked entry. A known locked subtotal above the target proves that removing
unlocked activities cannot suffice at those requirements; the reverse does not
prove feasibility. Unknown locked costs and exclusions remain explicit. Missing
budget yields `budget-unspecified`; invalid proposal/valuation yields
`unavailable` with null amounts, not a misleading zero or fallback target.
Non-budget domain issues conservatively disable this supplementary comparison.

Known subtotals and all mandatory disclosures now come from the answer compiler
and controlled renderer. The shared domain `assessLockedBudget` owns lower-bound
eligibility; tool and UI projections do not duplicate that decision. There is no
post-hoc numeric repair or raw model prose fallback. Semantic task selection and
source truth still need independent quality review.

Schema validation is repeated in the model guard, ADK tool and product domain.
The guard validates the whole model candidate before yielding any call to ADK,
so a seven-tool batch or an unknown tool cannot partially execute first.
Static instructions are separate from user/snapshot/tool data. Deterministic
injection tests prove the structural authority boundary, not live-model immunity
to every malicious prompt. See [Google function calling](https://ai.google.dev/gemini-api/docs/function-calling).

## Bounded execution

- Logical run: at most seven model calls and six model-requested tool calls,
  including the proposal. Saved ADK events restore counts, call IDs and prior
  proposal state across confirmation. Committed receipts need zero new model or
  final-tool calls; no acknowledgement slot is reserved. Ambiguous interrupted
  runs are not automatically retried.
- Invocation: parent at most 60 seconds; HTTP uses at most 55 seconds and no
  longer than the original admission lease. Gemini worker/provider share that
  absolute deadline instead of resetting it after startup or lock waits. Fixture
  ADK has a 55-second bound; the model decorator adds a 50-second bound. Human
  waiting time is not execution time. Cancelling does not undo commits.
- Model request: serialized content/config at most 96,000 UTF-8 bytes. Oversized
  context fails explicitly; no blind truncation of function-call/result pairs.
  Only the current product turn and its native ADK tool history are supplied.
- Output: 2,048 model tokens including thoughts, one candidate, no thought
  summaries requested; model-default thinking (no legacy thinkingBudget override); returned
  candidate at most 32,000 bytes. Tool output at most 16,384 bytes.
- Unary provider output is validated before ADK execution, then projected into
  persisted AG-UI events. This is **not token-by-token provider streaming**.
- Gemini transport: at most 30 seconds and no longer than the shared remaining
  deadline, abort propagated, one SDK attempt, no automatic retry. Timeout,
  refusal, malformed/truncated output and rate limits have sanitized codes.
- SDK numeric usage reaches a trusted callback before output validation can
  discard the response. Missing/inconsistent usage is `null`, never zero;
  model prose is not an accounting source.

Byte bounds are not a token estimate. `model-cost.ts` conservatively reserves the
model's full 1,048,576-token input capacity plus this application's 2,048 output
tokens, using the standard text reference prices above. Integer arithmetic rounds
each call upward: 265,216 USD microdollars/call, 1,856,512 for seven calls. Start
conservatively reserves seven calls; a deterministic resume reserves zero and
cannot generate. The durable counter permits only seven total for the logical
run, and a receipt may finish when all seven have already been consumed. This is deliberately loose,
not an expected bill or permission to pay. Non-prompt usage tokens are charged at
the higher output reference rate; cached input receives no discount. Malformed
or missing usage remains unknown. Public live activation remains disabled.

## Quota ledger and offline HTTP admission

Migration `005-quota.sql` adds durable reservations in USD microdollars, separate
from trip TWD. The service defaults disabled and requires explicit server policy.
Generation requires a positive worst-case reservation. Migration 013 permits a
zero reservation only for receipt continuations at the admission boundary; it
does not rewrite any historical reservation or settled receipt. A zero-cost
continuation bypasses only the cost-availability check, not invocation limits.
Synthetic prices are for offline tests;
`server-verified` is a caller assertion, not automated billing verification.

The ledger serializes global admission, including across Taipei midnight, then
day/IP/session/receipt locks. Defaults: three concurrent runs, five/IP/rolling
minute, 100/IP/day, 20/session/day. Request replay cannot start another model.
Settlement is immutable; unknown usage keeps the full reservation. Expiration
releases concurrency only, never possibly-spent budget or request counts.

Migration `006-agent-admission.sql` binds a provider/model and reservation to
each start/resume invocation, and stores private call-start/usage receipts. Quota,
run claim and invocation admission share one transaction. A rejected reservation
cannot leave a run or accepted decision behind. Session/day limits count logical
runs, so same-day confirmation is not a second turn; a continuation on a later
day counts once in that day's bucket. IP minute/day limits conservatively count
invocations, including continuations. Resume identity uses logical run + interrupt
and binds the decision, not the browser's new stream ID.

Provider mode cannot change across a run. Fixture claims and Gemini admission
serialize on the same global gate, preventing a check/claim race from bypassing
quota. Existing unbound runs remain fixtures. Completed request replay neither
loads a credential nor dispatches another worker.

Credential loading occurs only for generation start, after admission and within
the shared deadline. Confirmation and replay never invoke the loader, so an
unavailable key or exhausted generation budget cannot block a valid receipt.
The child receives configuration through private IPC, with a clean environment;
the key is not an ADK state field or public AG-UI event. Every call-start is
durable before transport; every usage callback is durable before model output
can proceed. All started calls, including those with missing usage, count toward
the seven-call logical-run cap. Missing receipts and interrupted execution keep
the full reservation; settlement failure leaves the conservative ledger charge.
Public AG-UI output still contains only the existing allowlisted event projection.

`quotaIpKeys` ignores request forwarding headers. It requires a verified network
peer address from the server, normalizes IPv4/mapped IPv6, derives daily hashes,
and supplies the previous day's hash during midnight's rolling-minute overlap.
Raw IPs are not stored. Ordinary workbench launchers are fixture-only and reject
retired live/provider options before database discovery or environment loading.
The old loopback proxy, IP-salt writer, live context factory and browser live
smoke entrypoints have been removed. The Next route selects fixture directly;
any explicit `DIVE_LOCAL_LIVE` value returns 503 before product HTTP handling.
Reviewed evaluation entries still provide their separate server capability;
there is no supported live workbench launcher or public ingress. The retained
`workbench_live` schema and its quota receipts remain read-only, separate from
fixture `workbench_demo`.

The runtime-only credential path is resolved from the project working directory,
not a bundler asset URL. It is opened read-only/no-follow after admission, with
regular-file/size/0600 checks, and no raw error propagation. UI mode comes from a
server API, not a client toggle; live mode warns against personal/secret input.
Ordinary live launch options are disabled; use the offline commands in
[README](../README.md). Returning to fixtures must not delete historical data
or IP hashing material.

Admission includes pool/row-lock elapsed time. Expiration or a Taipei day change
while waiting rejects the request, including a delayed commit response; a
possibly committed reservation remains charged, never authorizing a new model
call through replay. Real PostgreSQL lock-wait tests cover global, IP and session
locks, not only a mocked clock or an already-expired session.

## Compatibility and failure modes

The real SDK wire, captured only with synthetic credentials and replaced fetch,
exposed an ADK 2.1 / Zod 4 schema compatibility issue: `oneOf` and
`exclusiveMinimum` appeared in tool `parameters` but are absent from the
[Gemini Schema](https://ai.google.dev/api/generate-content#Schema) interface.
Strict literal-kind union branches (`anyOf`) and integer `min(1)` preserve the
accepted business inputs. `parametersJsonSchema` is a separate interface.
Wire regression establishes compatibility at this boundary, not the cause of
every historical HTTP 400.

A generic `AGENT_PROVIDER_ERROR` cannot distinguish authentication, request,
network or provider causes. HTTP 400 does not identify an invalid field; HTTP 404
does not prove model retirement or invalid credentials. A model listing is not
proof of generation access or free-tier entitlement. Safe diagnostics retain
only allowlisted codes; raw upstream messages, URLs and credentials are excluded.
Unknown provider usage stays unknown even when no public text/tool event appears.

Migration 007 preserves historical model rows and the immutable earlier
migration. Old-model runs cannot receive new accounting or resume under a new
model, and unknown settlement cannot use a newer cheaper reference price.
Model selection is explicit; no automatic fallback is authorized by an error.

Proposal prose alone is not a native confirmation gate. Minor units are not TWD
display units. A committed transaction does not require a second human approval.
These failure modes motivate the current validationId, typed-answer and fixed
receipt contracts; prompt wording and narrow smoke results cannot establish
general model quality.

Offline regressions use actual native ADK / worker / HTTP paths with synthetic
transport, including retired live activation rejection, persisted
confirmation, receipt-only resume and replay. They do not prove public ingress,
billing state or real-model task success. Revision-specific results and remaining
release gates are recorded in [release evidence](release-evidence.md).

## Remaining integration gate

Real-model evaluation requires an explicitly bounded entry with original local
history reconciliation, permanent claim, source binding, quota and independent
task/content review. Preserve failed reports and unknown usage; no public vector
or historical scope grants credential/model access. See
[evaluation](evaluation.md#real-model-entry-requirements).

Public hosting also requires its own ingress, billing/free-only activation,
retention, backup/restore and kill-switch acceptance. A caller assertion or key
shape cannot prove billing state. Do not enable live mode by modifying an
environment file or reusing a stopped entry.

Rollback keeps fixture routing and all quota tables, versions and ADK history.
Never change applied migration checksums or clear data to obtain more quota.
