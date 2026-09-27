# Cloudflare Workers AI adapter

Scope: provider contracts and offline synthetic-data regression. Ordinary live
launchers remain disabled; this document is not deployment or model authorization.
Google ADK TypeScript owns the loop, confirmation and session persistence;
AG-UI still receives the existing allowlisted event projection. No new runner.

## Transport and safety boundaries

- Fixed model: `@cf/google/gemma-4-26b-a4b-it`. Only the fixed model and its exact
  `-external` response alias are accepted; other returned models are rejected. The alias is not a selectable model or paid fallback.
- Account is server-only configuration, validated as 32 lowercase hex digits.
  HTTPS endpoint is pinned to `api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>`.
  No AI Gateway, inherited endpoint, redirects, plugins or retries.
- The shared ADK/chat-completion codec handles text, function schema and paired
  call IDs. OpenRouter-specific routing, cost and free-suffix checks remain in
  its adapter; Cloudflare never impersonates an OpenRouter model.
- OpenRouter and Cloudflare share the bounded unary REST lifecycle (dispatch,
  cancellation and evidence persistence); provider factories retain endpoint,
  request and accounting policy. This does not replace ADK's agent loop.
- Each call: 30-second transport bound within the invocation deadline, 96 KB
  serialized input, 2,048 completion tokens and 64 KiB response bound. Provider
  response is unary; AG-UI events do not imply token-by-token model streaming.
- The Cloudflare wire adapter pins `chat_template_kwargs.enable_thinking=false`
  on every request, including tool follow-ups, following the model-specific
  [Cloudflare example](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/).
  Caller ADK config, HTTP extra body and untrusted content cannot override it.
  This bounds the intended generation mode for the tool/AnswerPlan protocol;
  it neither guarantees a complete answer within 2,048 tokens nor proves zero
  reasoning usage. The adapter still validates optional reported thought counts;
  durable accounting continues to count completion tokens once, without adding
  or inferring a thought count. Gemini/OpenRouter settings and shared message/schema
  conversion are unchanged; no thought-text persistence or replay is introduced.
- Durable call-start ACK precedes dispatch; private usage ACK precedes model
  output. Cancellation after dispatch still attempts evidence persistence.
  Missing/invalid usage, failed envelopes and unexpected models fail closed.
- Actual tool execution and proposal schema validation remain in GuardedModel
  and ADK. Accepting a proposal still requires the existing product transaction.

### Non-thinking policy and diagnostic limits

A saved `finish_reason=length` diagnosis establishes truncation, not its
underlying cause. Without response body or thought-token breakdown, reasoning,
repeated text and oversized tool arguments cannot be distinguished. The prior
request policy left thinking mode unspecified.
Pinning the documented control removes that configuration ambiguity; it is a
candidate mitigation, not a claim that thinking caused the historical failure
or that the provider has now passed a live test.

Non-thinking favors a compact structured tool/answer protocol but may affect
task selection quality. Only a separately authorized live evaluation and actual
task/content review can establish that trade-off. No retry, fallback, higher
token cap, prompt-only workaround, parser relaxation or accounting change is
introduced. A length-truncated response still fails closed even if it contains
a syntactically valid tool call. Historical unknown receipts and consumed
campaign claims remain unchanged. See [current verification](evaluation.md#offline-regression-and-diagnostics).

## Accounting and persistence

Cloudflare usage includes reasoning in completion tokens. The worker does not
add it again as Gemini thought tokens. Input plus completion must equal total.
Reference prices verified against the [model page](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/):
USD 0.10/M input and 0.30/M output; round upward per call in microdollars, do
not discount cached input. These amounts are risk accounting, NOT actual bills.
Full 256,000-token input capacity plus the local output cap reserves 26,215
reference microdollars/call, up to seven calls per logical run. Unknown usage
retains the reservation. This is not a Neuron-meter or a guarantee of capacity.

Migration `011-cloudflare-provider` adds the fixed provider/model binding and a
server-only Cloudflare account ID. Existing Gemini/OpenRouter records retain a
null account ID and their original reservation hashes; unknown reservations
are unchanged. Switching provider/model/account on a resumed run is rejected
in the admission transaction, before credential loading or proposal application.
ADK session state independently checks the account; rotating a token within the
same account does not change this identity. Evidence stays private
in `model_calls`, never in AG-UI payloads. No migration is run against a live
workbench merely by adding the file.

The [Workers AI pricing policy](https://developers.cloudflare.com/workers-ai/platform/pricing/)
offers 10,000 Neurons/day on Workers Free, with operations failing past the
limit. Before separately authorized isolated model evaluation, an operator must
verify the account policy; ordinary live flags remain disabled. The application
does not query or change billing. Existing unrelated paid
services do not authorize Workers Paid or AI Gateway credits.

## Verification boundary and rollback

Public tests use de-identified offline vectors, fixed synthetic credentials,
replaced fetch and isolated PostgreSQL schemas. They verify account binding,
request policy, native ADK confirmation, usage persistence, private diagnostics
and public event projection. Numerical bounds do not prove real-model quality.
Latest whole-suite/browser results remain incomplete; see
[release evidence](release-evidence.md).

Original claims, reports, usage, reviews and retained schemas remain in ignored
local storage. Public vectors cannot authenticate those records or reset their
quota. Real-model use requires separate explicit bounded authorization,
original local closed-world history checks, source identity and a one-shot
claim. Ordinary live workbench options do not provide that capability.
See [entry requirements](evaluation.md#real-model-entry-requirements).

Preserve these failure-mode distinctions:

- Waiting on a browser response object can hang after the UI reaches a terminal
  state. Check persisted UI status, stream completion and private accounting
  separately; HTTP 200 alone is not success.
- A successful proposal/reload/accept/resume path can still have an incorrect
  answer. Current receipts come from the authenticated committed transaction,
  terminate native ADK without generation and use controlled AcceptedAnswer.
  Historical free-prose/Markdown rendering is not the current core contract.
- Tool-argument rejection can have known observed tokens but unknown settled
  cost. Only the narrowly defined current-invocation settlement exception can
  calculate a known cost; it never changes failed status or old receipts.
- A generic provider error cannot be relabeled as length truncation, rate limit
  or invalid credential. New private stage diagnostics do not repair missing
  historical evidence. Unknown usage stops further dispatch with reservation
  preserved.

The ten-case collector reuses account/model-bound usage audit, version 2 private
exports and run-bound review. Server-only catalog/fault overrides require
isolated test schemas; public request fields cannot select them. Review worksheets
remain pending/false until actual task/content review and aggregation.
See [evaluation](evaluation.md) and the
[review template](cloudflare-evaluation-1-review.md).

Rollback disables dispatch and returns to the ordinary offline fixture workbench.
Preserve credentials, provider bindings, immutable reports, claims and quota;
never reset schemas or reports to retry a stopped entry.
