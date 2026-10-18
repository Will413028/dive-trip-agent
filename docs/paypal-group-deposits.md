# Group Dive Deposits with Weather-Aware Settlement (PayPal Sandbox)

Status: design, 2026-10-12. Built for the PayPal AI Hackathon (deadline 2026-11-12 12:00 PT; target submission 2026-11-10). Everything described here runs against the **PayPal sandbox with synthetic data only**. No real money moves, and nothing in this module is a dive-safety judgment: whether a boat goes out is always the operator's call.

Decision record: [ADR 2026-10-12 PayPal hackathon demo profile](adr/2026-10-12-paypal-hackathon-demo-profile.md).

## 1. Problem

Divers travel across borders to dive with operators they have never met: a group from three countries books a liveaboard day trip in another country, and each diver pays a deposit to an operator abroad. Then the weather turns. The operator posts a free-text cancellation notice ("Day 2 boats cancelled due to swell, Day 3 TBC"), a marine alert appears in another format, and the forecast data disagree with both. Today someone reads all of that by hand, decides who owes what under the refund policy, and refunds each diver one by one. That process is slow, inconsistent, and a common source of disputes.

The cross-border framing is deliberate. It matches how dive travel actually works, and it also matches a real platform constraint: PayPal stopped domestic payments between Taiwan accounts ([The Paypers](https://thepaypers.com/online-payments/paypal-stops-domestic-payments-in-taiwan--761515)), so a Taiwan-only operator/diver flow is not a realistic PayPal use case. The demo uses **USD**.

## 2. What the module does

1. An organizer (dive operator or trip leader) creates a group booking: dates, dive site coordinates, seats, per-diver deposit, an immutable refund policy version, and a **mandate** that says what the agent may execute on its own.
2. Each diver joins through an invite link and places a deposit as a **PayPal authorization** (a hold, not a charge).
3. Before and during the trip, an AI agent reads the messy cancellation evidence, turns it into structured facts with citations, and proposes a settlement. The server computes every amount from the policy. Inside the mandate the agent executes; outside it, the agent stops and asks the organizer.
4. Money actions are void, partial capture, full capture, or refund, chosen by the server from each diver's payment state.
5. Every step lands on an append-only audit timeline that the organizer and each diver can read.

## 3. Payments design

### 3.1 PayPal objects

- **One Orders v2 order per diver**, `intent=AUTHORIZE`, one purchase unit. (Authorize intent does not support multiple purchase units in one order, so one order per diver is the natural fit anyway.)
- **Void** the authorization when the diver owes nothing (for example, the operator cancelled the whole trip).
- **Partial capture with `final_capture=true`** when the diver owes only the non-refundable part (for example, one of three dive days cancelled). The final capture closes the authorization, so the uncaptured remainder is never charged.
- **Full capture** when the trip runs normally (settlement point = trip start).
- **Refund only after capture**: if cancellation evidence arrives after the deposit was captured (for example, mid-trip), the refund goes through the Payments v2 refund endpoint for the captured amount owed back.

Rule of thumb: **never charge and then refund when a void or a smaller final capture achieves the same outcome.** That avoids refund fees and avoids "your money was taken" UX.

### 3.2 Money commands, idempotency, reconciliation

Every PayPal write is a **money command** row stored before it is sent:

| Field | Purpose |
| --- | --- |
| `kind` | create_order, authorize, capture, void, refund |
| `amount_minor` | USD cents, computed by the policy engine |
| `paypal_request_id` | UUID sent as `PayPal-Request-Id`; unique |
| `invoice_id` | deterministic, e.g. `GB-{booking}-{diver}-capture`; unique |
| `state` | pending, sent, succeeded, failed, unknown |
| `paypal_object_id`, `response_digest`, timestamps | reconciliation and audit |

Write order: insert command (`pending`) and commit, mark `sent`, call PayPal with the stored `PayPal-Request-Id`, then record the result in a transaction.

On an unknown outcome (timeout, 5xx, connection reset), the client **retries with the same key** while the command is still inside PayPal's idempotency window. The Orders v2 reference states that request keys are stored for 6 hours by default and can be extended to up to 72 hours on request ([Orders v2](https://developer.paypal.com/api/orders/v2)). Outside the window, or when retries still fail, the command is resolved by **GET-reconciliation**: read the order, authorization, capture, or refund and record what actually happened. A command is never re-issued under a new key while its outcome is unknown. `DUPLICATE_INVOICE_ID` and `DUPLICATE_REFUND` responses are treated as "may already have succeeded" and routed to reconciliation, not to failure.

Domain preconditions are checked before any command is created: a voided authorization cannot be captured, refunds cannot exceed captured-and-unrefunded amounts, and each diver has at most one in-flight command (partial unique index).

**Webhooks are nice-to-have.** The MVP relies on synchronous responses plus a periodic **reconciliation sweep** over `sent` and `unknown` commands. If webhooks are added, they only trigger reconciliation; they never mutate state directly.

**Nightly cron** voids every uncaptured demo authorization, so sandbox holds never linger.

### 3.3 Production extension (not built)

Authorizations are valid for 29 days, with a 3-day honor period. Trips booked further ahead would need reauthorization or capture-at-booking plus refunds. The demo keeps trips a few days out, so neither is implemented; they are listed here only as the path to production.

## 4. The AI agent's role

The rules engine can compare a wave height to a threshold. It cannot read *"Due to the northeast swell all boats are cancelled tomorrow; Thursday morning dives depend on the 6 pm update"*. That gap is where the agent earns its place.

### 4.1 Inputs

Unstructured cancellation evidence that rules cannot parse:

- the boat operator's free-text cancellation notice (typed or pasted by the organizer);
- raw marine or weather alert text;
- mixed forecast data (Open-Meteo Marine hourly values, see section 5).

All inputs are data, never system instructions. Each input item gets an evidence ID.

### 4.2 Tools (server-wrapped)

| Tool | What it does | What the model can and cannot supply |
| --- | --- | --- |
| `get_booking` | Booking, divers, payment states, policy version, mandate | Read only |
| `get_weather` | Normalized forecast plus stored notice and alert texts with evidence IDs | Read only |
| `propose_settlement` | Submits **structured facts**: cause, affected days, evidence citations, confidence; returns the server's per-diver actions and mandate preview | Facts only, never amounts or percentages; each citation is a short quote that must appear verbatim in the cited evidence |
| `execute_within_mandate` | Asks the server to execute a stored proposal | Proposal ID only |
| optional read-only PayPal Agent Toolkit order lookup | Lets the agent answer "what is the status of my deposit" | Read only; no money-moving toolkit tools are exposed |

### 4.3 What the server does

1. Validates the facts: cause must be defined in the policy, days must be inside the trip, and every cited evidence ID must exist in this run's input.
2. **Computes all amounts deterministically** from the immutable policy version and each diver's payment state, then picks void, partial capture, capture, or refund per diver.
3. Runs **deterministic threshold rules** (wave height, alert present) as a **sanity guard, not a veto**. Disagreement does not discard the proposal, because an operator notice can legitimately cancel a day that the forecast numbers do not flag. It removes auto-execution and shows "AI and rules disagree" to the organizer.
4. Checks the **mandate**: auto-execute cap per diver and per booking, allowed actions, allowed causes, expiry. Inside the mandate, `execute_within_mandate` creates money commands. Outside it, the agent stops and the organizer approves or rejects. The organizer can correct facts, not amounts; the server recomputes.
5. Auto-executes only when every gate passes: the agent called `execute_within_mandate` on its latest proposal, rated its confidence high, agrees with the rules guard, and the mandate check passes. Each failed gate is a reason shown to the organizer (`AI_REQUESTED_REVIEW`, `AI_NOT_CONFIDENT`, `AI_AND_RULES_DISAGREE`, mandate reasons). The agent runs over a snapshot; its tools never touch the database or PayPal, and only verified quotes reach the UI.

### 4.4 Models and fallback

PydanticAI `FallbackModel`: Groq (`gpt-oss-120b`), then Gemini Flash (Workers AI optional). Groq comes first because Gemini's free tier allows about 20 requests a day. Each provider is tried once. If every model fails, or the daily cap is reached, the server produces a **policy-only "No AI" proposal** from the threshold rules. That proposal always needs human approval.

### 4.5 Light rules for live model calls

This module uses its own light governance and does not change the repository's existing claim and quota machinery:

- synthetic data only;
- an environment-configured daily cap (default **50 live runs/day**), with auto-stop when it is reached;
- a separate call-log table owned by this module (existing quota tables are untouched);
- when the cap is hit, the UI shows precomputed results, clearly labeled **"Recorded AI result"** with model and timestamp. A recorded result is the latest successful live result for the same policy terms and the same evidence content (evidence IDs differ per booking and are remapped); the same replay also covers a failed live call (for example a free-tier rate limit); with nothing to replay, the assessment is "No AI". The call log records failures as short reasons such as `RATE_LIMITED` or `MODEL_NOT_FOUND`. Every started live run counts, including failures, and call rows outlive workspace resets.

## 5. Weather and time

- **Open-Meteo Marine API**: no key, with wave and swell height and wind waves. Open-Meteo itself notes limited accuracy near the coast and says the data must not be used for navigation, so it is evidence for policy, not a safety signal.
- **Operator notice text input** on the organizer page.
- **"Simulated typhoon/storm" switch** (demo only): it inserts synthetic forecast values and a synthetic alert text, flagged `is_simulated`. A banner marks every affected screen and audit entry.
- **Temporal**: one simple `GroupBookingWorkflow` per booking, with a timer to the next check or settlement point and a `check_now` signal. The **demo fast-forward button** sends `check_now`, which runs the next scheduled step immediately. There are no compressed clocks and no run pinning.

## 6. Judge experience

- **Isolated workspace per judge**: opening the demo creates a workspace token; every booking, payment, and audit event is scoped to it. "Reset" voids that workspace's uncaptured authorizations and rebuilds it.
- **Seeded group**: on workspace create or reset, the server authorizes the other group members itself through Orders v2 with `payment_source.card` and **sandbox test cards**. No buyer login is needed. (Sending raw card data from a server is acceptable only for sandbox test cards; production would use PayPal-hosted card fields.)
- **The judge pays exactly one deposit** as a guest card payment in the PayPal checkout. If the week-1 spike shows that guest card authorization fails in sandbox, the fallback is one shared sandbox buyer account, documented in the Devpost testing notes and kept out of the public repository.
- **README "Try it in 3 steps"**: (1) open the demo and join the seeded group, (2) pay your deposit with the listed sandbox test card, (3) flip "Simulated storm" or paste the sample operator notice, press fast-forward, and watch the agent propose, execute, or ask.
- **Synthetic text only**: the operator notice input says "Paste demo text only", because pasted text goes to a free-tier model, and offers a one-click synthetic sample notice that the agent can read and the threshold rules cannot.
- A **"PayPal sandbox status"** note links PayPal's status page and explains what to do if the sandbox is degraded. A **recorded fallback video** shows the full flow.

## 7. Deployment: separate demo profile

The demo runs as a **separate profile on the owner's own VM**: an independent compose stack (API, worker, Temporal dev server, PostgreSQL), its own database, and its own hostname (for example, its own tunnel hostname). It holds synthetic data only and is fully rebuilt every night. The existing hosted P7 deployment path, its configuration guard and trigger that forbid model configuration, and its migration chain all stay untouched. If the project ever stores real user data, it returns to the P7 path (see the ADR revocation triggers).

## 8. Scope

**Must-have (MVP, 2026-11-02)**

- Per-diver AUTHORIZE orders; void, partial capture with `final_capture`, full capture, and refund after capture, all real in sandbox
- Money commands with `PayPal-Request-Id` and `invoice_id`, same-key retry, GET-reconciliation sweep, nightly void cron
- Immutable policy versions, a deterministic settlement engine, and a mandate check
- Agent with the four tools, evidence citations, FallbackModel, a "No AI" proposal, and the daily cap with recorded results
- Open-Meteo Marine, operator notice input, simulated storm switch, fast-forward
- One Temporal workflow per booking
- Isolated judge workspaces, server-seeded card authorizations, guest card payment
- Append-only audit timeline
- Demo stack on the VM

**Nice-to-have**

- Webhooks (signature-verified, reconciliation trigger only)
- Read-only PayPal Agent Toolkit order lookup
- Workers AI as a third fallback

**Cut**

- Reauthorize and capture-at-booking ("paid") mode
- TWD and zero-decimal rounding
- Taiwan CWA data
- Hash-chained audit
- Payouts
- Diver self-cancel
- Any change to the hosted P7 deployment, its model-config ban, or its migration chain

## 9. Milestones (about 4 part-time weeks)

| Week | Dates | Work | Exit |
| --- | --- | --- | --- |
| W1 | 10-13 to 10-19 | Sandbox spike (see Open questions); policy engine and property tests; migration | Spike notes; policy tests green |
| W2 | 10-20 to 10-26 | PayPal client, money commands, reconciliation, workflow, join and pay UI | Local end-to-end: authorize, then void, partial capture, capture, refund |
| W3 | 10-27 to 11-02 | Weather adapter, simulation, agent, mandate, approval, timeline; VM demo stack | **MVP 11-02** on the demo hostname |
| W4 | 11-03 to 11-10 | Reset and cron hardening, README guide, Devpost copy, video, buffer | **Submit 11-10** |

## 10. Three-minute video outline

1. 0:00–0:20: The problem. A cross-border dive group, weather uncertainty, and manual refunds.
2. 0:20–0:50: The organizer creates the booking, policy, and mandate; divers join; the deposit shows "On hold, not charged".
3. 0:50–1:50: A messy operator notice and a marine alert arrive. The agent cites the evidence and proposes "Day 2 cancelled". The server computes amounts: one diver is voided, others get a partial final capture. A larger case exceeds the mandate, and the agent stops and asks.
4. 1:50–2:20: The organizer approves. The audit timeline matches the PayPal sandbox transactions.
5. 2:20–2:40: A mid-trip cancellation after capture shows a refund.
6. 2:40–3:00: Architecture. The model reads, the program computes money, and the mandate or a human approves; idempotency keys and reconciliation.

## 11. Top risks

1. Guest card or server-side card authorization may behave differently in sandbox (mitigation: W1 spike, sandbox buyer account fallback).
2. Free model tiers rate-limit during judging (mitigation: daily cap, recorded results, "No AI" path).
3. Sandbox outages during judging (mitigation: status note, fallback video).
4. Part-time schedule (mitigation: hold the must-have list; the nice-to-have list is the first to go).
5. Agent misreads a notice (mitigation: citations, the rules guard, the mandate cap, and organizer approval for anything outside it).

## 12. Planned follow-up (not edited now)

The README and AGENTS.md product contract currently say the product provides no booking or payment. A follow-up change will state that group booking deposits are in scope **for the demo profile only**, still with no real money and no dive-safety endorsement.

## 13. Sandbox verification (W1, 2026-10-12)

Run against a US sandbox business account with the sandbox test Visa `4111 1111 1111 1111`, USD 100.00 deposits:

| Check | Result |
| --- | --- |
| Orders v2 create with `payment_source.card`, `intent=AUTHORIZE` | `201`, order `COMPLETED`, authorization `CREATED` in the same response; no buyer login, no 3-D Secure challenge; authorization expires 29 days later |
| Partial capture USD 30.00 with `final_capture=true` | `201 COMPLETED`; authorization becomes `CAPTURED`; a further capture returns `422 AUTHORIZATION_ALREADY_CAPTURED`, so the remainder is closed |
| Same `PayPal-Request-Id` retry of that capture | `200` with the same capture ID (no duplicate charge) |
| Void with no captures | `200`; authorization `VOIDED` |
| Full capture, then refund USD 40.00 | refund `201 COMPLETED`; capture `PARTIALLY_REFUNDED` |

A payee account outside the US (sandbox country C2) rejected the card order with `422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`, so the demo merchant must be a US sandbox business account.

Guest card checkout (2026-10-13, local demo stack, JS SDK card button, `intent=authorize`): the server creates the AUTHORIZE order without `payment_source`, the buyer approves it in PayPal's inline card form, and `onApprove` asks the server to call `orders/{id}/authorize` under the stored money command's request ID.

| Check | Result |
| --- | --- |
| Sandbox test Visa `4012 8888 8888 1881` from PayPal's card-testing list | authorization `CREATED`, diver on hold for USD 100.00 |
| Generic `4111 1111 1111 1111` in the same guest form | `422 INSTRUMENT_DECLINED` on authorize (the same number works for the server-side `payment_source.card` seed) |
| Form fields | the US billing form requires a mobile number; the SDK calls `createOrder` before field validation and may call it again |

A diver joins once (`POST …/divers`, server-issued id) and each deposit hold is a separate attempt under that diver: a checkout order (`…/divers/{id}/checkout`, then `…/authorize` on approval) or the server's sandbox test card (`…/divers/{id}/test-card-hold`). Rejoining under a name that holds nothing yet resumes that diver; a seeded or held name is `409 DEPOSIT_NAME_TAKEN`. A new attempt replaces a checkout order that was never sent for authorization (closed as `CHECKOUT_REPLACED`); an approval of the replaced order later is `409 DEPOSIT_ATTEMPT_CLOSED` and places no hold, because only our authorize call does. An attempt already sent to PayPal blocks new ones (`409 DEPOSIT_HOLD_IN_FLIGHT`) until it settles or trip-start reconciliation retries it. Creating an AUTHORIZE order moves no money, so the checkout order is created first and stored with its attempt in one step; an order whose attempt is refused or replaced is never authorized and expires at PayPal. Each attempt records its method and order, so reconciliation retries a test-card attempt with the card and a checkout attempt with its order. A PayPal answer we cannot record (an authorization that is not `CREATED`, or none at all) keeps the attempt open as unknown, since a hold may exist; reconciliation retries each open attempt independently, and reset and the nightly void reconcile first, so such a hold is recorded and released rather than lost; reset keeps a booking whose holds it cannot confirm released (`{"deleted", "kept"}`) instead of deleting the record. Known limit: an authorization PayPal returns as `PENDING` or for a different amount stays unknown without its authorization id, so it blocks that diver and is left to the 29-day expiry; sandbox test cards authorize `CREATED`. Store and void that returned authorization before using live credentials or once sandbox returns `PENDING`. Business conflicts are `409` with a code (typed `DepositConflict`); `503` is kept for a database or PayPal outage, and any other failure is `500`.

Still open:

1. Duplicate `invoice_id` responses and same-key retries for create and refund; how long PayPal keeps an idempotency key.
