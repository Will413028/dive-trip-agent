# Public source preparation

This is an implementation sub-plan of the [master plan](2026-09-19-dive-trip-agent.md), not a second roadmap.

## Scope and acceptance

- Preserve the original tracked tree and complete Git history in ignored local backups before sanitizing. Do not alter historical reports, claims, receipts or retained database schemas.
- Replace account/run/trip/owner/schema identities and report/owner provenance pins in public regression fixtures. Keep numerical boundary vectors so refusal/accounting tests retain their discrimination; these fixtures are not proof of model quality or current account usage.
- Separate identity data from carry-forward validation. Public fixture imports perform no filesystem IO. A live entry, after its existing authorization check but before claim/database/credential work, must load the fixed local identity profile and verify its pinned digest. No profile override, missing-profile fallback or quota reset.
- Scope the approved private profile to the asynchronous evaluation only; construct identity-dependent schemas within that context. Check profile integrity again at dispatch/final-history boundaries. Existing grant, claim, lock, source fingerprint, report hash, raw inventory, unknown-usage and budget checks stay in force.
- Keep public documentation portable and honest about failed/unverified tests and model quality. No personal workflow, private ledger diary or implied live authorization in shared instructions. Do not select a software license on the owner's behalf.
- Inspect all publication content, not just the current file names. Use a parentless local Git baseline with a verified GitHub noreply identity. Retain the existing repository and URL: rewrite its single initial commit locally, preserving the original in the verified private backup. Remote history replacement, public visibility and CI execution remain separate external actions requiring approval.

## Validation

1. Backup verification and before/after hashes of the retained reports/claims.
2. Profile isolation, bounded immutable reads, missing/changed profile, CI rejection and pre-claim failure regression tests.
3. Existing carry/scheduler/entry unit suites, typecheck and lint. Do not relax timeouts or reinterpret the pre-existing full-regression/browser failures as passing.
4. Independent design review and a fresh content/history scan of the exact candidate tree; inspect the final diff and links.

## Retained mechanisms

| Mechanism | Original reason | Still applicable | Decision / re-evaluation trigger |
| --- | --- | --- | --- |
| Closed historical identity and digest pins | Reports and DB rows must belong to the same audited execution | Yes, publishing code does not forgive historical usage | Move only private identity data out of source; re-pin only after a separately reviewed history migration |
| Exact numeric boundary vectors | Detect forged usage, unknown receipts and quota resets | Yes for regression coverage; not live-quality evidence | Retain de-identified numbers with explicit fixture labels; change only with corresponding accounting-contract tests |
| Two complete inventory captures and dispatch-time checks | Detect changes while asynchronous work executes | Yes; no cross-pool atomic snapshot is claimed | Keep and add private-profile integrity to the same boundary |
| One-shot authorization and non-deletable claims | Prevent retries and accidental additional charges | Yes regardless of repository visibility | Keep; source publication never grants another evaluation |
| Separate original Git backup | Deleting current lines does not remove earlier commits | Yes | Retain the same repository and replace its single initial commit with a clean local root. Keep the private backup outside publication refs; remote replacement still requires approval |
| Private profile schema | Old code had literal anchors; the new profile is a versioned data format | Yes; provenance pins do not define field kinds | Define an explicit schema first; fixtures satisfy it, never infer private validation from example values. Re-evaluate only with a reviewed profile-version migration |
| Scoped async identity context | Each one-shot evaluation must use one approved history throughout async callbacks | Yes; no caller-selected history and no product/UI consumers | Keep `AsyncLocalStorage.run`, frozen scope data and active revocation; default fixture lookup stays pure and expired scopes fail closed. Reconsider explicit bound descriptors if a single evaluation must compare multiple approved profiles or the comparator becomes a general-purpose library |
| Lazy IO, CI refusal and fixed errors | Public fixture imports must neither read local history nor expose IO payloads | Yes, including CI and clones without the private file | Preserve lazy private imports, pre-IO CI refusal and fixed error codes; re-evaluate only if an explicitly approved deployment needs private evaluation, never by removing the local guard |
| Shared bounded artifact reads | Reports and identity profiles both require canonical, nofollow, bounded immutable file reads | Yes; content limits, provenance and lease rules differ, filesystem protection does not | Share the byte/directory primitive with bigint metadata and immutable snapshots; keep profile and report policy wrappers separate. Re-evaluate only if the trusted-local-filesystem boundary changes |

The scoped-context choice uses the lifecycle documented by
[Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage).
That source supports asynchronous context propagation, not a claim that ALS is
universally better than explicit dependency injection. The schema-first contract
uses the existing Zod dependency; no new package is required.

## Independent design-review disposition

Three initial suggestions were reviewed against the actual constraints. After
checking its evidence, the reviewer retained two and withdrew the third:

- **B1 — shared file protection: changed.** Report and profile policies differ, so
  the old report-reader decision did not mandate reusing its whole wrapper.
  Nevertheless, consolidate only the bounded, nofollow byte/directory mechanism;
  preserve fixed names/pins, claim/lease semantics, limits and profile snapshots
  in their respective policies. The shared primitive retains bigint metadata,
  immutable cross-read snapshots and lazy IO. Boundary and caller regressions
  passed; the profile's existing counterexamples remain unchanged. This is not
  a new live authorization.
- **B2 — fixture-derived private format: changed.** Added the independent
  `cloudflare-history-contract.ts` strict schema and derived types. A regression
  that changes a public example without changing an approved private profile
  failed before the fix and passed after it; affected checks passed.
- **B3 — implicit async context: rejected/withdrawn.** The reviewer found no
  closed-scope or authorization violation and withdrew the demand for explicit
  DI as a design preference. The scope, revocation, concurrent fixture isolation
  and no-fallback tests support retaining the bounded context choice above.

Disposition: change 2, record-only 0, escalate 0, reject/withdraw 1. No unresolved
architecture choice is delegated to the user; remote publication remains its
own authorization boundary.

## Rollback

The ignored verified bundle and tracked-tree archive preserve the original implementation and its local working-tree change. Retain them and all historical artifacts. If validation fails, keep the repository private and CI paused; do not delete claims, rewrite ledgers, force-push, or replace the user's working tree as a shortcut.

## Existing repository publication

- Keep the repository identity, name and URL; do not create or rename a remote repository.
- Replace the single initial commit with the reviewed source, exact-path staging and noreply author/committer metadata. Preserve the original private bundle and do not publish a backup branch/tag or merge the old history back in.
- A separately approved push must target only `refs/heads/main`, using an explicit expected old SHA with `--force-with-lease`. Stop on any remote divergence; never substitute `--force` or `--mirror`.
- Keep `[skip ci]`, private visibility and the CI pause during replacement. Recheck remote branches, tags, pull-request references and old-commit reachability afterward. A rewritten branch is not proof of server-side purge; GitHub may retain cached old commits. Address that exposure before approving public visibility, following [GitHub's removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Progress

- Original history and tracked working tree backed up and verified.
- Identity separation and portable documentation cleanup implemented. The fixed profile contains 45 private identity/pin bindings; fixture data contains no original values.
- Offline verification: 3308 unit tests passed; 15 affected integration tests passed and 9 live tests remained skipped; typecheck and lint passed. This does not replace the outstanding full integration/browser regression or real-model quality gates.
- Original report/review digests and claim inventory are unchanged. The dedicated disposable integration database was isolated from history and stopped after verification.
- Independent correctness/security review found no actionable issue; the design-review B1/B2 recheck found no remaining design blocker. B3 remains withdrawn for the reason above.
- Clean-history verification covers the exact file checksum manifest, reachable commit/blob objects, a single parentless commit and noreply author/committer metadata. Known-private-value and key-pattern scans are bounded checks, not a universal guarantee that source contains no sensitive information. Local backups, reflogs and the unchanged remote-tracking ref intentionally retain private history; only the rewritten main is a publication candidate, not `--all` or a mirror push.
- No public visibility change, push, CI run, credential read, historical database mutation or model request in this task.
