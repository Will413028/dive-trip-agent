# Evaluation contracts and offline regression

## Python／Temporal evaluator（2026-09-29）

現行 reviewed controller 保留永久 claim、完整原始 history／source manifest／owned lease 與 quota gate；執行改用 inherited duplex 連接 Python child。需先安裝 `backend/uv.lock` 固定環境，並明示已安裝且版本相符的 `DIVE_TRIP_TEMPORAL_BINARY`。一般 Web 仍只提供 fixture；此設定不構成 live 授權。

每批新執行使用獨立 PostgreSQL schema 與持久 SQLite Temporal history；不接續舊 ADK run。只有 start admission 後才取得一次 generation capability，resume 為 receipt-only。新 private usage v3 核對產品帳本及 pinned Temporal execution 的完整 native history，不能把下方舊 ADK v1／v2 格式轉換成新成功證據。

Capture 必須等 owned worker 與 SDK 收尾；成功清理前再次查原始歷史，並在 migration lock 與完整 table locks 下比對最終 storage fingerprint。漂移、未知 drain、匯出或保存失敗均保留新 schema／SQLite 及其 metadata。既有原始 claims、reports、unknown 與 retained DB 不變。離線驗證與切換證據見 [核心重構](architecture-refactor.md)；以下既有停止、品質與歷史規則持續適用，ADK 專屬實作段落僅供歷史查核。

This repository provides de-identified offline regression vectors. They exercise
domain, transport, accounting and review boundaries; numerical correctness does
not establish real-model understanding, evidence selection or task quality.
No current real-model quality pass or public deployment is claimed. The source
repository is public. The first [fixture CI run](https://github.com/Will413028/dive-trip-agent/actions/runs/36317342675)
passed on `2a3d3d5` on 2026-09-27; its job and every step concluded successfully.

Original non-deletable claims, reports, usage, review receipts and retained
databases stay in ignored local storage. Public vectors are not that ledger:
their synthetic identities, hashes and values cannot authenticate a private run,
establish remaining quota, or reset history. A real-model entry needs separate
explicit bounded authorization and a fresh check of original local history.

2026-09-29 新版Python／Temporal [Fixture CI](https://github.com/Will413028/dive-trip-agent/actions/runs/36460356520) 在 `ab80b3f` 的唯一job及全部steps通過：3036 unit、388 integration／11 live skipped、262 backend、67 production browser／5 skipped，另含靜態檢查、build及隔離DB清理。這是離線驗證；模型呼叫數與內容品質仍待獨立驗收。

## Historical ADK fixture CI boundary

The same CI run completed **3308 unit passed, 388 integration passed / 11 live
skipped, and 63 production Chromium E2E passed / 5 skipped**. Lint, strict
typecheck, fixture boundary, production build and disposable DB teardown passed.
The job took 8m58s on Ubuntu 24.04 with Node 26.8.1 and pnpm 11.2.2. Unit and
integration suite durations were 47.39s and 317.61s; browser duration was 1.3m.
Timeouts, assertions and Agent deadlines were unchanged. These are results from
one run, not selective rechecks assembled into a pass.

The 11 integration skips are opt-in live tests. The five browser skips are two
opt-in replay scenarios in each browser project plus the mobile recording case.
Mobile here means a 390px Chromium viewport, not a physical mobile device.
The dedicated `test:adk` probes and `playwright.replay.config.ts` are outside this
CI scope. Separately, local actionlint and the 30-record domain fixture self-check
passed; the latter reported `modelCalls:0`, `liveEvidence:false` and
`evaluationGatePassed:false`. Neither is real-model quality evidence.

### Historical checkpoints

| Scope | Recorded expanded-suite checkpoint |
| --- | --- |
| Unit | 3141 passed |
| Whole unit + integration batch | 3519 passed / 10 integration timeouts / 11 live skipped |
| Integration portion of that batch | 378 passed / 10 failed |
| Production browser | 54 passed / 9 failed / 5 skipped |
| Strict typecheck, lint, actionlint, production build | Passed at the recorded checkpoint |
| Current real-model quality | Not passed |
| Remote CI / public deployment | Not exercised at that historical checkpoint |

The publication cleanup has a separate verification result: **3308 unit passed,
15 affected integration passed / 9 live skipped, typecheck and lint passed**.
That cleanup did not rerun full integration, build or browser tests, trigger
remote CI, or deploy publicly. It did not clear the expanded-suite/browser
failures above; the subsequent complete CI run supplies the new fixture pass.
The earlier 2776-test scope and selective rechecks are not substitutes for that
run. The old failures remain historical evidence, not a proven common root cause. See
[release evidence](release-evidence.md) for the remaining release gates.

## Current answer contract

Collector results and replay bundles use version 2. They validate
`CUSTOM: dive_trip.answer.v1` AcceptedAnswer, run binding, reference structure,
idempotent answer identity and durable stream equality. Raw model/tool prose
cannot become a new core answer. Historical version 1 is isolated, read-only
inspection data, never migrated into a successful new answer or replayed through
the new core UI. Original reports, grades, claims and unknown costs stay intact.

Each start/resume phase needs its own new immutable answer ID. A prior proposal
cannot stand in for a resume receipt. Commit status and version are checked
against the frozen product transaction receipt and before/after checkpoints,
not inferred from model output. Native tool counts include the ADK final-response
tool; public progress counts cannot substitute for missing private history.

New confirmation receipts need no model call. `auditAcceptedAnswerUsage` accepts
zero-call resume only when the run is quiescent and succeeded, its reservation
is settled with actual/charged cost zero, no resume model-call row exists, and
native tool events, saved AcceptedAnswer, public completion phase and frozen
product receipt agree. Provider kind/model/account must also match.
Later manual edits do not rewrite that receipt. Missing proof stays unknown.

Both audit versions share one pure cost-reconciliation core; only the explicit
version policy permits an independently proven empty resume. There is no second
fallback cost calculation after a failed legacy audit. New receipt invocations
reserve zero model cost and carry no generation credential; rate, concurrency,
ownership, TTL, binding and historical costs still apply.

`textReview` is the retained field name for independent task/content review.
Renderer safety alone cannot set it to passed. Review must assess understanding,
necessary clarification, selection, evidence completeness and goal completion.

## What is implemented

`pnpm eval:fixture` runs ten domain-oracle fixtures, three rounds each. It does
not instantiate ADK, call an LLM, execute tools, read keys, access a DB or mutate
a trip. Its stdout report has `liveEvidence:false`, `modelCalls:0` and
`evaluationGatePassed:false`. Fixture latency is domain CPU time, not model
latency; zero model expense is not a prediction of a provider's costs.

`evals/cases.json` defines ambiguous needs, non-diver companion, locked lodging
with lower budget, free afternoon, changed party size, unknown costs, no dates,
source injection, lookup timeout and impossible party size.
`fixtures.ts` constructs independent synthetic inputs and expected states.
Change fixture versions when inputs/oracles change; compare the same version
of each case across rounds.

`gradeCase` uses domain rules to check snapshots, all existing locks, date and
destination preservation, trusted catalog/original items, unknown costs,
requested removals, requirements and unchanged fields. It rejects unrequested
IDs and checks actual free-slot occupancy, not just disappearance of an old ID.
Exclusions remain unless a trusted expectation replaces them. An unchanged state
cannot pass a requested edit. Model prose is never an oracle.

The grader alone does not verify approval, authorization, complete tool history,
factual truth, fabricated booking claims or prose quality. Trusted catalog data
is an input boundary, not proof that its facts are true. Do not use arbitrary
report JSON or model-created verdicts as release evidence.

## Coverage and acceptance

Attempts record round, case ID, fixture version, unique run ID, mode, model,
latency, tool count, nullable USD microdollar cost, outcome and findings.
Skipped, cancelled, failed and timed-out slots stay in the denominator. Missing
or duplicate `(round, case)` pairs and reused run IDs invalidate coverage.
Fixture versions must match for each case; model identity must match throughout.

The aggregate gate requires exactly 3×10 unique live attempts, at least eight
successes per round, zero safety failures, known latency/cost for every attempt,
each latency below 60 seconds and at most six tools. Fixture/live mixing is
rejected. A populated 30-slot worksheet is not proof that all cases were attempted.
A successful preflight or smoke cannot pass the full gate.

Nearest-rank p50/p95 use all measured attempts, including failures; missing
latencies are counted separately. Known cost is summed exactly as a decimal
string. Unknown cost is counted, never rendered as free. Missing costs on skipped
slots are distinct from unknown accounting receipts on dispatched calls.

## Collector and review evidence

`evaluationInput(caseId)` supplies independent before-state, catalog,
expectations, terminal and required fault, bound by SHA-256. The digest is not
a signature. The model receives only the prompt and permitted context, never
grader expectations or oracle answers.

`collectCase` uses real HTTP handlers, admission, AG-UI start/resume, native ADK
confirmation, pre-decision reads and private run-bound usage. Offline integration
replaces provider transport with fixed synthetic responses and no native-network
fallback. Bounded SSE decoding checks UTF-8, chunked events, comments, terminal
events and partial EOF; HTTP 200 alone is not completion.

`gradeEvidence` checks identity, unchanged pre-decision state, proposal/run/decision
binding, exactly one accepted version, read-only side effects, successful run,
complete usage, finite known cost, limits, observed fault and review.
Missing or pending proof fails closed. `textReview:passed` in caller-supplied JSON
is not authenticated review, and expected terminal is provisional rather than
a semantic observation.

The lookup timeout is a server-selected synthetic fault confined to isolated
test schemas. Public HTTP fields cannot select it. The collector records it only
when the actual tool result contains the timeout; this is not evidence of a real
provider outage. Source-injection protocol tests do not establish universal
model immunity.

`buildReviewPacket` produces a bounded 30-slot worksheet of answers, actual
tools, requirement/entry differences and domain-recomputed budgets. Durable audit
rows are not extra attempts. Missing slots and pending review remain visible;
the worksheet itself always has `evaluationGatePassed:false`.
Use the [review guide](evaluation-review.md), including distinctions
between technical failure, task failure and absent evidence.

Current monetary answers derive target budget, unit price, known subtotal and
locked lower bound from typed evidence and server rendering. These are different
quantities. Null is unknown, a locked lower bound below a target does not prove
feasibility, and DEMO/source/unit/exclusion disclosures remain mandatory.
Historical free-prose contracts are inspection-only; do not retroactively regrade
their output using the current renderer.

## Real-model entry requirements

The ordinary `evals/run.ts` CLI rejects `--live`. Live tests are opt-in and
default-skipped; a flag or a test filename is not permission. Before a new entry:

1. Obtain explicit authorization for the provider, bounded case scope, maximum
   calls/invocations and credential use. Confirm the operator's billing/free-tier
   constraints separately; an application flag cannot verify provider billing.
2. Reconcile original local claims/reports and retained DB inventory under the
   owned campaign lock. Freeze current source inputs and enforce existing quotas.
   Public fixtures cannot replace missing private history.
3. Use an independent permanent one-shot claim, fixed report/review bindings,
   server-only capability, verified loopback peer and isolated synthetic schema.
   Consume the claim even if preflight fails. Load credentials only after admission.
4. Before each dispatch and before successful cleanup, recheck history, source
   manifest and lease. Checkpoint the conservative dispatch count before HTTP.
   Stop on changed evidence, technical/safety failure, rate limit or new unknown.
5. Preserve every attempted outcome and remaining skipped slot. No retry,
   fallback, extra filming call, identity rotation or budget reset is implied.

The included-preflight scheduler evaluates round-1 `unknown-cost` and `no-date`
inside the same thirty-slot denominator. Both need technical success and primary
plus independent task/content review before the remaining 28. The current
proposal-only continuation bound is 30 starts plus at most nine resumes:
39 invocations and at most 210 model calls. These are implementation limits,
not an active grant or evidence that quota has room for the batch.

Each logical run is limited to seven model calls. Existing admission includes
20 logical runs/session/day, five invocations/IP/minute, 100 invocations/IP/day,
concurrency and a configured cumulative reference budget, such as US$3.
Reference headroom is not an actual bill, a free-tier entitlement or a guarantee
all cases fit. Historical invocation/charge carry is not silently reset by a
new schema, day or report.

Dispatch spacing remains at least 15 seconds; the collector retains its
60-second deadline. History/checkpoint latency must not shorten spacing.
For the diagnostic included-case policy, the scheduler recomputes the task
predicate after every slot, including later rounds. A supplied passing grade
cannot override `GOAL_MISSED`; only `TEXT_REVIEW_REQUIRED` may remain pending.
It saves original result and private audit before `GOAL_EVIDENCE_STOP`.
Older fixed policies keep their own semantics; no old report is regraded.

The review barrier binds one immutable checkpoint to both case/run identities
and source hash. Each case needs primary and independent passing decisions with
no findings. Require boolean `true`, not a truthy value. Poll only for an absent
review file, at most 180 seconds; malformed, stale, failed or missing review stops.
Persist the exact accepted/rejected payload and immutable receipt before
checkpointing the decision and dispatching another case. Technical completion
or a preflight receipt never sets the final quality gate.

## Closed-world history integrity

Public identities and numeric vectors are regression inputs, never private
provenance or remaining quota. `cloudflare-history-contract.ts` defines the
private profile format independently of public example values. Default fixture
lookup performs no filesystem IO; authorized live entries load one fixed,
digest-pinned profile before claim, DB or credential access, with no caller path
override or missing-profile fallback. CI rejects private loading before IO.

`cloudflare-history-profile.ts` freezes that profile in an `AsyncLocalStorage`
scope and revokes it when the evaluation ends. Escaped inactive contexts fail
closed; concurrent fixture work does not inherit private identities. Integrity
is rechecked at dispatch/final-history boundaries. Explicit bound descriptors
should be reconsidered if one evaluation must compare multiple approved
profiles or the comparator becomes a general-purpose library.

Profile and report policies share `bounded-artifact-file.ts` for canonical,
bounded, immutable reads with bigint metadata and directory/file snapshots;
their names, pins, size limits and lease requirements stay separate. Keep the
original private Git bundle/tree archive and historical artifacts ignored.
Never merge or publish the private backup history into public refs; source
publication does not authorize another model run or reset historical usage.

Local history readers use closed descriptors: fixed paths, report hashes, schema,
run/trip/owner/provider/model/account bindings, known sidecars and expected
unknown receipts. Never accept arbitrary caller-provided history paths, hashes,
schemas or a public fixture as provenance. Extra, missing, duplicate or modified
rows/artifacts block carry even if aggregate counts/costs are unchanged.

Capture complete bounded inventories, public/native events, current snapshots,
invocations, reservations and private usage. Verify receipt/call associations and
run identity, including raw call IDs, not only totals. Each pool uses a bounded
read-only repeatable-read transaction. The outer history check compares two
complete linear captures, including raw rows and normalized evidence.
A cleaned successful scope can be checked only against its immutable export;
do not claim a fresh DB audit or fabricate missing detail.

Multiple pools may point to schemas in the same database. Two-pass stability is
conservative drift detection, not a simultaneous cross-schema snapshot.
If history becomes writable or a single-time snapshot is required, redesign
around one transaction or an exported snapshot before relying on carry.

Audit pools explicitly select loopback, the synthetic test database/user,
non-credential synthetic password, SSL policy and bounded timeouts.
Connection strings are rejected because they can override supplied fields and
reactivate environment/passfile credential fallback. Pools must satisfy the
fixed scope and distinct-object/same-port checks. Do not alter global DB settings.

Pinned readers use fixed paths, bounded regular-file reads, NOFOLLOW/NONBLOCK,
content hashes and file/directory identity checks. Symlinks, special files,
unexpected future campaign artifacts and changed inventory block entry.
An owned opaque lease must survive identity checks before/after reads and writes;
a lost lease cannot remove a replacement lock. Node lacks openat here: this is
a trusted-local-filesystem/cooperating-runner boundary, not hostile ABA protection.

`readCloudflareSourceManifest` hashes sorted path/content identities from fixed
source roots (`src`, `evals`, `migrations`, `tests/support`,
`tests/integration`, `backend/src`), required Node and Python config／lock／runtime
version files, and `data/catalog.json`. JS/TS variants, JSON, SQL and Python
source are included; docs, hidden files, credentials, installed packages and
generated/history artifacts are excluded.
Reject symlinks/special files, changing inventories, files over 2 MB, total input
over 32 MB or more than 2048 entries. This is bounded source identity, not a
hermetic-runtime claim or proof about installed binaries.

`historyConsistent` does not imply `dispatchAuthorized`, `accountingComplete`
or `evaluationGatePassed`. Any explicitly pinned historical unknown stays
unknown with its full conservative charge; it is not a general exception for
new unknowns. Observed token counters and a complete total are separate.
Never delete reports, claims, locks or retained schemas to bypass a denial.

## Private accounting evidence before cleanup

`exportUsageEvidence` captures an owner/trip/run-bound repeatable-read snapshot
of invocation/reservation/call IDs, model/provider binding, statuses, usage,
reference costs and timestamps, only in isolated `test_<32 hex>` schemas.
Cloudflare's version 2 export binds its fixed model and account; the historical
Gemini format remains separate. Audit and export reconcile each invocation and
reject cross-run/account evidence. No keys, prompts, raw provider bodies, session
tokens or IP hashes are projected. Local call IDs are not provider request IDs.

Call-start must be durable before dispatch and usage durable before model output.
Unknown or invalid usage retains the full reservation. A failed invocation with
observed tokens can still have `actual_cost_micros:null`; token observation alone
does not authorize repricing. Settled receipts are immutable.

The sole failure-settlement exception is a current runtime tool-argument
rejection after worker close and accounting-hook drain. In one settlement
transaction, recheck every call's complete valid usage, provider/model/account,
owner/run/reservation binding and cancellation/expiry. At least one completed
call is required. Missing evidence, timeout, abort, crash or persistence failure
retains the full reservation. The run stays failed and the campaign stops even
when cost is known. Never backfill an old settled-null receipt.

Before cleanup, checkpoint public run/events using a same-directory 0600
temporary file, fsync and atomic rename, then export private usage and persist
the final checkpoint. Partial write/rename errors must preserve the earlier
checkpoint. Export/persistence failure causes `EVIDENCE_EXPORT_STOP` and prevents
another dispatch. The opted-in `retainOnFailure` keeps the exact isolated DB for
forensics; stopped batches are retained even with known usage.
Ordinary tests and successful campaigns retain their defined cleanup policy.

Cancelled SSE is not proof of worker completion. Drain checks one terminal run,
matching terminal event and settled invocation/reservation under one five-second
acquisition/polling deadline, with queries bounded to one second. Late results
cannot turn timeout into success. Unconfirmed quiescence marks export incomplete.

`privateUsageComplete` means export completed, not that usage is known.
Null usage/cost remains null; incomplete private export blocks future carry even
when every attempt row exists. Retained schemas and atomic replacement are not
off-device backup or whole-machine power-loss guarantees. Old missing call detail
must not be invented.

## Offline regression and diagnostics

Use a unique `COMPOSE_PROJECT_NAME` for disposable offline regression, shared by
Compose startup and the test process. Never carry it into historical audit or
live evaluation; those must reconcile retained local history. Do not delete
historical schemas to improve timing. ADK init and schema cleanup share a DDL
gate, so file workers are serialized; concurrent transactions inside tests remain.

The recorded comparison found slower SDK initialization in the history-bearing
DB than in a separate clean DB. It did not prove every uninstrumented timeout's
cause. Storage A/B/A did not establish a stable tmpfs benefit; durability settings,
test limits and Agent deadlines were not relaxed. The later clean CI run passed
all 388 integration tests and all 63 active production browser cases at their
original limits, including the previously failing test files. This does not
identify every local timeout's cause or guarantee cross-environment stability.

Browser failures require independent evidence: HTTP 200, a saved version and UI
visibility are different checkpoints. A captured successful stream followed by
late UI/runner completion does not prove a DB or business-logic root cause.
A stream with no captured terminal body cannot be called successful.
Measure SQL/lock, worker and browser stages separately in a controlled run.

Provider diagnostics are deliberately limited:

- `AGENT_TOOL_ARGUMENTS` retains only bounded allowlisted tool/issue/path metadata
  in private ADK events, never argument values. Absent original values cannot be
  reconstructed from a field path.
- Python／Temporal 新執行的 `AGENT_TOOL_ARGUMENTS_REJECTED` 將同類診斷綁在
  `planning_model_steps` 的 activity，與拒絕標記同一交易保存。只記固定工具名、
  批次內序位、最多八種去重後的固定 issue code 與各最多八段白名單路徑；
  索引記 `*`，未知欄位記 `?`，
  不記參數值、Pydantic message 或任意欄位名。私有 usage evidence 的 v3 step
  增加可選欄位；舊 row 維持 null，公開事件與 Temporal failure 仍用固定代碼。
  migration021 只新增 nullable 欄位，不回填或重新解讀已停止的評估。
- A saved `response/length` diagnosis proves truncation, not why the model reached
  the cap. The fixed non-thinking request policy retains the 2048-token cap,
  strict AnswerPlan and no retry; it is not proof of improved real-model quality.
- The earlier recorded non-thinking attempt has generic `AGENT_PROVIDER_ERROR`
  with no usable usage or structured stage/reason and stops on
  `UNKNOWN_USAGE_STOP`. It cannot be relabeled as a proven length failure,
  rate limit or invalid credential. A controlled failure answer is not task success.
- The 2026-09-29 Python diagnostic stopped after the first included case:
  one known-usage call completed `validate_changes`, then a second call ended
  around the local 30-second client limit without usable usage. The retained
  Temporal history records the fixed `AGENT_PROVIDER_TIMEOUT` classification;
  that code also covers upstream HTTP 408/504, and neither the original status
  nor exception was retained. The native model activity failed, the public run
  ended `AGENT_INTERRUPTED`, and all remaining 29 slots were skipped by
  `UNKNOWN_USAGE_STOP`. The one-shot claim, private
  report, isolated DB and Temporal storage remain; no review or retry followed.
- A later offline SDK regression reproduced `httpx.ReadTimeout` being wrapped by
  PydanticAI as `ModelAPIError` and misclassified as an invalid response. New
  fixed private activity codes distinguish local 30-second deadline,
  SDK/transport timeout, and observed HTTP 408/504. The original diagnostic
  retains its ambiguous historical code. Public `RUN_ERROR`, one dispatch per
  call, unknown usage and the stop policy are unchanged; no new live call was made.
- A separately authorized Free-only one-case probe is limited to `unknown-cost`,
  one invocation and seven model calls. Its new permanent claim cannot reopen
  `cloudflare-diagnostic`. The private digest-pinned Python history profile
  binds that stopped report and its replay sidecar, the synthetic PostgreSQL
  schema's complete table fingerprint, original owner/run/provider/account
  evidence, and the retained Temporal SQLite bytes and execution identity.
  Every admission and final check repeats the old eight-scope carry and this
  new scope twice. A technically complete case would record
  `diagnosticComplete: true` and retain raw storage; new unknown/technical
  failures also retain it. No one-case outcome satisfies the thirty-case
  quality gate or replaces the independent reviews. The 2026-09-29 probe used
  one invocation and four known-usage model calls, then stopped at
  `FAILED_RUN_STOP`: three `validate_changes` tools completed, the fourth
  model step's tool arguments were rejected, and Temporal retained
  `AGENT_TOOL_ARGUMENTS_REJECTED`. The claim, report, PostgreSQL schema and
  Temporal SQLite remain; no new unknown usage or quality pass was recorded.
- The second Free-only `cloudflare-probe-2` entry is a distinct one-shot technical
  scope for `unknown-cost`, one start and at most seven model calls. Its pinned
  private carry includes the failed first probe's exact report/replay, all 22
  retained PostgreSQL tables and the Temporal execution/argument marker, as
  well as the preceding nine scopes. A failed preflight still consumes its
  claim; an attempted run retains its own DB and Temporal evidence. Even a
  technically complete result leaves the thirty-case quality gate false. The
  2026-09-30 attempt used one invocation and one known-usage call, then stopped
  at `FAILED_RUN_STOP`: the first `validate_changes` candidate was rejected
  before any tool completed. The new bounded private diagnostic says
  `invalid_value` at `changes.*` for candidate ordinal 1; it contains no raw
  argument value and cannot identify the model's exact mistake. Offline
  synthetic validation reproduces this same safe code/path for a missing or
  unsupported change `kind`; an empty requirements patch has a deeper path.
  This narrows the next offline check to discriminator handling without
  rewriting the original evidence. The new claim,
  report/replay, PostgreSQL schema and Temporal history remain. A two-pass
  read-only post-run audit matched all 22 raw-row tables, replay hash, execution
  Run ID and Temporal rejection marker. No new unknown or quality pass arose.

- New private REST diagnostics permit provider plus locally selected
  `request`, `call-start`, `fetch`, `body-read`, `body-json`, `evidence`,
  `response`, `evidence-save`, or `http` with integer status 0–599.
  Strict decoding is bounded to 512 characters. URLs, headers, keys, prompts,
  bodies, upstream text and exception details remain excluded. Public errors
  keep fixed codes. This cannot retroactively diagnose old generic failures.

For this one-case extension, the carry-over decisions are:

| Mechanism | If designed afresh today | Current constraint and decision | Reconsider when |
| --- | --- | --- | --- |
| One-shot local claim before preflight | On one trusted host, exclusive file creation and sync of a permanent claim | Earlier claims and protected reports are a fixed trusted-local inventory; keep the same mechanism with a new scope | Multiple hosts or untrusted artifact writers require a coordinated ledger |
| Digest-pinned private history profile | Under the same local trust boundary, a fixed digest and bounded immutable reads | One retained local scope and closed-world identity binding; pin a new digest, never reinterpret the stopped report | Independent verifiers or untrusted storage require signed or transactional provenance |
| Two complete read-only captures | For immutable scopes, two linear captures and full raw-row equality; use an exported DB snapshot if writers return | Retained scopes are immutable and the owned lease covers cooperating runners; keep two-pass drift detection | Historical schemas can be written again or cross-schema atomicity becomes required |
| Server transport marker and technical scheduler | Separate server-only transport authority from claim, admission and run budget checks | Keep distinct checks; the marker alone never grants dispatch or credentials, even for one local runner | Hosted or multi-run evaluation may change representation, not the authorization boundary |
| Retained evidence and replay sidecar | Preserve an attempted technical run's immutable report and replay plus bound PostgreSQL/Temporal storage | The first failed probe remains available for complete historical comparison; the next technical attempt retains its own storage | Retention policy or storage backend changes under an explicit evidence migration |

Fixed offline malformed-JSON/invalid-tool scenarios verify the real
worker→ADK→HTTP persistence/privacy path without a provider request.
Native worker TypeScript compatibility is checked separately from bundled code;
see [toolchain](toolchain.md). New diagnostics do not clear a historical stop.

## Commands

No live opt-in or credential is needed for these offline commands:

```sh
pnpm catalog:validate
pnpm eval:fixture
pnpm exec vitest run tests/unit/evaluation.test.ts --maxWorkers=1
pnpm exec vitest run tests/unit/cloudflare-diagnostic-campaign.test.ts --maxWorkers=1
pnpm typecheck
pnpm lint
```

After starting an independent Compose test DB as described in [README](../README.md):

```sh
pnpm exec vitest run tests/unit tests/integration --exclude '**/*live*.test.ts' --maxWorkers=1
# Focused REST/provider regression, not a replacement for the complete suite:
pnpm exec vitest run tests/unit \
  tests/integration/rest-diagnostic-http.test.ts \
  tests/integration/cloudflare-runtime.test.ts \
  tests/integration/cloudflare-http.test.ts \
  tests/integration/openrouter-runtime.test.ts \
  tests/integration/openrouter-http.test.ts \
  --maxWorkers=1 --reporter=verbose
```

Run build/browser serially with the workbench stopped if they share its build
directory. `catalog:validate` checks schema and DEMO/coordinate/unknown-price
counts; it does not fetch source URLs or certify facts/licensing.
See [data sources](data-sources.md), [assets](assets-license.md) and
[release evidence](release-evidence.md).
