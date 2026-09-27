# OpenRouter adapter — offline stage

Status: adapter, provider/model binding, private accounting, ADK worker IPC and
HTTP/AG-UI offline integration are implemented. The existing default remains
fixture; original campaign history and unknown-usage stops remain unchanged.
Ordinary live workbench flags are disabled. A separately authorized isolated
model entry requires a server-selected free model and original local history
checks before credential loading. Public de-identified regression vectors are
offline evidence only; they cannot authenticate private history or reset quota.
Original claims, reports and usage stay in ignored local storage. See
[evaluation](evaluation.md#real-model-entry-requirements).

## Contract

- Uses the installed ADK `BaseLlm` interface and existing `GuardedModel`; ADK still
  owns the model/tool loop and human confirmation. This is a provider transport,
  not a replacement agent framework. No new dependency was downloaded.
- Requires a server-selected, immutable named `vendor/model:free` per adapter
  instance. There is deliberately no default model yet. Synthetic model names in
  tests are not recommendations or evidence of available endpoints.
- Pins `https://openrouter.ai/api/v1/chat/completions`, rejects redirects, emits
  unary requests, limits input to 96 KB, response to 64 KiB and output to 2048
  tokens. Caller configuration cannot override model, endpoint, retries, routing
  or add plugins. No SDK or application retries are performed.
- Requests no provider fallback, parameter support, denied data collection and
  zero maximum token/request/image prices. If no compatible free endpoint exists,
  fail rather than relaxing constraints. These request restrictions are not a
  provider billing guarantee or proof of account-level configuration.
- Await call-start acknowledgement before transport, then save private evidence
  before yielding output. Evidence includes requested/returned model, generation
  ID, token counts and reported cost, not prompt/response text or credentials.
  Missing/malformed usage or cost remains unknown and fails the call. Nonzero
  reported cost fails. A response from another model is saved but rejected.
- OpenRouter reasoning tokens are a subset of completion tokens. Do not reuse
  Gemini's additive thought-token accounting or Gemini reference prices.
- Text and paired function-call/result history only. Tool declarations use the
  project's Zod JSON Schema directly, preserving required nullable fields. ADK's
  guard remains responsible for tool allowlists, argument validation and run-wide
  call caps. Upstream reasoning/raw diagnostics are not exposed.
- Cancellation after dispatch still attempts evidence persistence within the
  invocation deadline; an expired deadline or persistence failure cannot be
  described as complete accounting. The future durable call-start row must stay
  unresolved in that case. No response is yielded after cancellation.

The known model-name acceptance is the selected `:free` identifier or its base
name without that suffix. Any additional provider alias needs explicit review,
not a broad acceptance rule.

## Offline verification

The adapter suite exercises real ADK Runner + native tool confirmation using an
in-memory session and mocked fetch: proposing does not execute the tool, human
confirmation resumes execution, and the final answer passes through the adapter.
It also covers exact wire policy, nullable JSON Schema, tool IDs, unknown usage,
nonzero cost, malformed/truncated output, 429 without retries, failed ACKs,
oversized/hanging bodies, model mismatch and cancellation during persistence.

The synthetic integration path crosses the real ADK worker process, PostgreSQL
admission/accounting and the HTTP/AG-UI stream: start produces a proposal,
human confirmation resumes the same binding, and private evidence settles a
zero-cost free response. Provider changes on resume are rejected. Missing
OpenRouter usage remains an unknown reservation rather than zero. This is not
live-model quality evaluation or public workbench acceptance.

Verified 2026-09-23: 446 unit tests, the focused provider/local-context/runtime/
admission/HTTP/launcher suite (37 tests), 219 integration tests and 2 intentionally
skipped live tests passed; strict typecheck, lint and production build passed.
Native timeout uses a real short deadline because fake timers do not control
`AbortSignal.timeout`. No live request or production deployment was performed.

## Next integration gate

1. Before any separately authorized live smoke, select an available tool-capable
   named free model, verify endpoint/account policy, original local history and
   remaining quota. The local setup wizard does not grant model authority or
   send a model request; credentials must never appear in chat or public artifacts.
2. Run at most the explicitly authorized small synthetic live smoke; stop on
   unknown usage, rate limits or any non-zero reported cost. Do not add paid
   fallback or automatic model switching.

Rollback at this stage: leave OpenRouter unselected and keep the offline fixture
workbench; ordinary live launchers remain disabled. The additive migration is required for the
new provider columns/constraints, but no existing rows or credentials are
rewritten.

## Official references checked 2026-09-22

- [Provider routing and maximum prices](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Response, tool calls and usage](https://openrouter.ai/docs/api_reference/overview)
- [Free-model limits](https://openrouter.ai/docs/api_reference/limits)
- [Data collection policy](https://openrouter.ai/docs/guides/privacy/data-collection)

These describe the protocol, not a guarantee that any specific free endpoint
supports this project's complete interaction flow.
