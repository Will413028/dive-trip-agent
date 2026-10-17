# Devpost submission draft

Draft copy for the PayPal AI Hackathon (deadline 2026-11-12 12:00 PT). Claims below must match what has been verified; see the checklist at the end before submitting.

## Tagline

Weather-aware group dive deposits: an AI agent reads the cancellation notice, PayPal holds the money, and the server decides who pays what.

## Inspiration

Divers often book a boat with an operator in another country they have never met. A group from Osaka, Madrid and Singapore pays deposits to an operator in the Philippines, and then the swell picks up. The operator posts "Day 2 boats cancelled, Day 3 TBC", a marine alert says something slightly different, and the forecast disagrees with both. Today someone reads all of that by hand, works out the refund policy for each diver, and refunds them one by one. It is slow, inconsistent and a classic source of disputes.

## What it does

- The organizer creates a group booking with a refund policy and a **mandate**: how much the agent may move back to divers on its own, which actions and causes it may handle, and until when.
- Each diver's deposit is a PayPal **authorization**, a hold rather than a charge. Divers pay as guests with a card through PayPal checkout.
- When evidence arrives (a pasted operator notice, an alert, a forecast, or a simulated storm), an AI agent reads it through read-only tools, decides which trip days were cancelled and why, and **cites short verbatim quotes** from the evidence. It never supplies an amount.
- The server checks every citation against the stored evidence, computes each diver's amount from the immutable policy, and picks the PayPal action per diver: **void** when nothing is owed, **partial capture with `final_capture`** when part of the deposit is kept, **full capture** at trip start, and **refund** only if money was already captured.
- Inside the mandate, and only if the agent is confident, asked to execute, and agrees with a deterministic weather-rule guard, the settlement executes automatically. Otherwise it stops and the organizer sees exactly why ("AI and rules disagree", "per-diver cap exceeded", ...) and approves or rejects.
- Every step lands on an append-only timeline that matches the PayPal sandbox transactions.

## How we built it

- **PayPal Orders v2 and Payments v2** in sandbox: one `intent=AUTHORIZE` order per diver, then void, partial final capture, capture or refund. Every PayPal write is stored as a money command with its `PayPal-Request-Id` and `invoice_id` before it is sent; unknown outcomes are retried with the same key or reconciled with a GET, never re-sent under a new key.
- **PayPal JS SDK** card button for the guest diver's own deposit; the server creates the AUTHORIZE order and authorizes it on approval under the stored request ID.
- **PydanticAI** agent with four server-wrapped tools (`get_booking`, `get_weather`, `propose_settlement`, `execute_within_mandate`), a `FallbackModel` (Groq `gpt-oss-120b`, then Gemini Flash), a daily live-call cap with a separate call log, and replay of recorded results for identical evidence.
- **Temporal** workflow per booking (timer to trip start, `check_now` and `approve` signals), **FastAPI**, **PostgreSQL**, **Next.js**.
- Deployed as an isolated Docker Compose stack on a small ARM VM, exposed through Tailscale Funnel and rebuilt from scratch every night after voiding every open sandbox hold.

## Challenges we ran into

- Never charging first and refunding later: choosing void or a smaller final capture per diver from their current payment state.
- Making retries safe for money: idempotency keys, deterministic invoice IDs and reconciliation instead of blind re-sends.
- Keeping the model out of the money path: the model can only cite and classify; quotes are verified server-side and amounts are computed by code.
- Guest card checkout in sandbox: the generic `4111…` number is declined in the guest form while PayPal's listed sandbox Visa `4012 8888 8888 1881` authorizes; the SDK also calls `createOrder` before form validation and may call it again, so a diver joins once and each order is a replaceable hold attempt under that diver.

## Accomplishments that we're proud of

- Real sandbox money movement end to end: holds, voids, partial final captures, captures and refunds, with an audit timeline that matches.
- A mandate that makes autonomy explicit and bounded, and an agent that can say "this is TBC, I'm asking the organizer" instead of guessing.

## What we learned

- Authorizations plus `final_capture` express "keep only what the policy allows" more cleanly than charge-then-refund.
- Treating rules as a sanity guard rather than a veto lets the agent handle what thresholds cannot read (an operator cancelling for its own reasons) without letting it act alone when the signals disagree.

## What's next

- Reauthorization or capture-at-booking for trips more than 29 days out.
- Webhook-triggered reconciliation and a read-only PayPal Agent Toolkit lookup for "what is the status of my deposit".

## Built with

PayPal Orders v2, PayPal Payments v2, PayPal JS SDK, PydanticAI, Gemini, Groq, Temporal, FastAPI, PostgreSQL, Next.js, TypeScript, Python, Docker, Tailscale.

## Try it

https://dive-deposits.tail357fef.ts.net/deposits, then follow "Try it in 3 steps" in the repository README. Sandbox test Visa: `4012 8888 8888 1881`, any future expiry and CVC.

## Testing notes for judges

- **Sandbox only.** Every payment is a PayPal sandbox transaction on synthetic data; no real money moves. Never enter a real card.
- **Your own workspace.** Each browser gets a private workspace with up to five bookings; **Reset workspace** releases its holds and deletes them. The whole demo is rebuilt every day at 10:00 UTC, after every open sandbox hold is voided.
- **Guest card.** Use PayPal's sandbox Visa `4012 8888 8888 1881`, any future expiry and CVC, and made-up contact details (the US billing form asks for a mobile number). The generic `4111 1111 1111 1111` is declined in the guest form.
- **Free-tier AI.** The agent runs on free model tiers (Groq first, Gemini as fallback) with a daily cap. When a provider is rate-limited, identical evidence replays a clearly labelled *Recorded AI result*; otherwise the deterministic rules produce a *No AI* proposal that always needs approval. If you see *No AI*, wait a minute and press **Check evidence now** again on new evidence.
- **Not a safety tool.** Whether a boat goes out is always the operator's call.

## Sandbox status

If the PayPal sandbox or a model provider is down during judging, the recorded video shows the full flow, and the audit timeline on any existing booking still shows every recorded PayPal call.

## Checklist before submitting

- [x] Live AI path verified on the public demo with Groq `gpt-oss-120b` (2026-10-14): a verbatim citation that stops on "AI and rules disagree", auto-execution inside the mandate, and a stop on per-diver and per-booking caps outside it.
- [x] Guest card checkout verified through the public URL in a browser (2026-10-17, revision eb429a5): PayPal card form with sandbox Visa `4012 8888 8888 1881`, authorization succeeded and shown on the timeline; the server test-card fallback also places the hold after an abandoned card checkout under the same name.
- [ ] Refund-after-capture shown in the UI: settle Day 2 (partial final capture), then add Day 3 evidence and check again; captured divers get a sandbox refund. Verified through the public API on 2026-10-14 (USD 33.33 refunded to each of four captured divers after approval); not yet recorded in the browser.
- [ ] Recorded fallback video (about 3 minutes, outline in the design doc section 10).
- [x] Sandbox status note and judge testing notes drafted above; paste them into the Devpost form.
