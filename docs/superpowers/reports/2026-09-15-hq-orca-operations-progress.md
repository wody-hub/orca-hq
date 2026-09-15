# HQ + Orca Operations Console Planning Progress

- Date: 2026-09-15 KST
- Status: Integration fix round 1 independently reviewed — Spec PASS / Quality PASS / Overall PASS for R1–R5
- Plan: `docs/superpowers/plans/2026-09-15-hq-orca-operations-implementation.md`

## Completed

- Focused independent R1–R5 re-review (2026-09-16 KST): **Spec PASS / Quality PASS / Overall PASS**. Inspected current allowlisted source and durable regressions, reused recorded **1,336 root tests / 105 files**, **46 web/API**, **55 gateway/adapter**, **4 E2E**, build/typecheck results, and ran only an in-memory pending/unknown cleanup and cancellation probe (passed). Corrected the candidate `.diff` to a descriptive ledger with no machine-verifiable baseline claim. Remaining app-lifetime, partial-scan, and fake-child/whole-service-crash limitations are explicit in `2026-09-15-hq-orca-operations-integration-fix1-review.md`; earlier positive security findings are carried forward without a fresh broad audit.

- Integration fix round 1 implements the R1–R5 review corrections: app-session pending/unknown identity fencing, native terminal `handle`, bounded and reconciled question traversal on all three consumers, reviewed strict boolean dispatch injection with truthful unsupervised semantics, and a combined fake-executable Unix-claim/real-HTTP/auth/journal/parser smoke. Focused green runs cover 46 web/API tests and 55 gateway/adapter tests; the full root suite passes **1,336 tests / 105 files**, root build and source/test typechecks pass, and all four Chromium E2E cases pass. The process-interruption evidence is a fake Orca child exiting during an effect followed by orderly service/SQLite close and reopen, not a whole-server crash. See `2026-09-15-hq-orca-operations-integration-fix1.md` and `.diff`; the prior BLOCK remains historical until independent re-review.

- Task 4 Spec/Quality + Task 5 fresh independent gate: **Spec BLOCK / Quality BLOCK / overall BLOCK**. Three targeted probes reproduce unknown mutation identity loss on evidence-tab inspection, native terminal `handle` versus browser `id` rejection, and pending HQ questions hidden after the first event page. The review also identifies missing approved dispatch injection and a material gap between the claimed combined fake-process smoke and the durable tests. Reused the recorded 1,326 root tests / 104 files, 37 web tests, four Playwright cases, and typecheck/build; no broad rerun or code fix. See `2026-09-15-hq-orca-operations-integration-review.md` for exact R1–R5 locations, evidence, and required corrections.

- Task 4 ships the reviewed mutation console, owner-socket `hq console` launcher, fail-closed indexed Vite asset serving, root build ordering, usage guidance, restart-safe mutation journal coverage, responsive Playwright acceptance, and isolated package-artifact proof. Focused web/gateway/installer tests, four Playwright cases, root typecheck/build, and the final **1,326-test / 104-file** root suite pass. The root run exposed and Task 4 repaired one Task 1 regression where public redaction normalized harmless durable-result whitespace; the focused long Korean completion/compaction/idempotency regression now passes without weakening credential redaction. See `2026-09-15-hq-orca-operations-task4.md` and `task4.diff`; Task 5 owns the fresh independent integration review.

- Task 3 fix round 2 independent review: **Spec PASS / Quality PASS**. The refreshed first-page owner now aborts and supersedes in-flight pagination while restoring readiness, and the stale continuation remains generation/signal fenced. The review reused the recorded focused red/green regression, **31 web tests / 2 files**, and web typecheck; see `2026-09-15-hq-orca-operations-task3-fix2-review.md`.

- Task 3 fix round 2 addresses the remaining Q4 pagination state defect: changed first-page reconciliation now advances one generation fence, aborts obsolete pagination, and restores readiness without permitting late settlement to mutate rows, cursors, or state. TDD red reproduced the disabled “읽는 중” control; green passed the focused regression, **31 web tests / 2 files**, and web typecheck. See `2026-09-15-hq-orca-operations-task3-fix2.md` and `task3-fix2.diff`; independent re-review is pending and Task 4 remains out of scope.

- Task 3 fix round 1 independent review: **S1/S2/Q1/Q2/Q3 addressed; Spec PASS / Quality BLOCK** in `2026-09-15-hq-orca-operations-task3-fix1-review.md`. The review reused the recorded 30 tests plus typecheck/build and found one deterministic remaining quality defect: a changed first-page poll can abort in-flight pagination without restoring `pageState`, permanently disabling load-more. Task 4 remains out of scope.

- Task 3 fix round 1 addresses review S1/S2/Q1/Q2/Q3: source-honest Orca inbox observations, native Run/Task inspection, AbortSignal/generation fencing, stable exhausted and invalidated pagination chains, and actual-contract response bounds/discriminants. TDD red established 12 failures; green passed **30 tests / 2 files**, typecheck, and build (39 modules). See `2026-09-15-hq-orca-operations-task3-fix1.md` and `task3-fix1.diff`; independent re-review completed with Spec PASS / Quality BLOCK, and Task 4 remains out of scope.

- Task 3 independent review: **Spec BLOCK / Quality BLOCK** in `2026-09-15-hq-orca-operations-task3-review.md`. Required fixes separate unverifiable Orca inbox observations from actionable attention, restore approved Run/Task read coverage, abort stale log/pagination reads, preserve exhausted/compacted pagination state across polling, and enforce the published response bounds/discriminants. The review reused the recorded 19 tests plus typecheck/build/local-asset checks; Task 4 placeholders and controls were deliberately excluded.

- Task 3 real read-first React console implemented across overview, work/source-filtered details, questions, resources, settings, and evidence, with compose/reply controls explicitly deferred to Task 4. Typed dependency-free runtime response schemas follow final Task 2 native shapes; claim/coalesced CSRF recovery, cancellation/non-overlapping polls, cursor/compaction handling, separate HQ events/Orca logs, unavailable metrics, and unsupported capacity mutation are explicit. Focused web verification passed **19 tests / 2 files**, typecheck, build, and local-only asset checks; see `2026-09-15-hq-orca-operations-task3.md` and `task3.diff`.

- Task 2 fix round 1 independent re-review: **R1/R2/R3 ADDRESSED; Spec PASS / Quality PASS** in `2026-09-15-hq-orca-operations-task2-fix1-review.md`. The review reused 74 targeted/affected passing tests and the recorded gateway/test-support typechecks; no new breakage was found within the fix, and Task 3 may consume the finalized route matrix.

- Task 2 fix round 1 resolves review R1/R2/R3: delayed-body expiry rejection, monotonic exhausted/compacted question cursors, and explicit legacy-fake rejection for added operations. Seven new cases failed before fixes; 74 targeted/affected tests passed afterward, gateway/test-support and strict changed-test typechecks passed, and four HTTP tests passed again after a test-helper annotation fix. See the updated Task 2 report and `2026-09-15-hq-orca-operations-task2-fix1.diff`; independent re-review passed and Task 3 remains pending.

- Task 2 initial independent review: **Spec BLOCK / Quality BLOCK** in `2026-09-15-hq-orca-operations-task2-review.md`; it required expiry checks after asynchronous body reads, a monotonic exhausted HQ-question cursor, and correction of the expanded-union fake regression. Fix round 1 addressed all three and the re-review passed; recorded 110+37 passing tests remain valid within their stated scope.

- Task 1 final review: `2026-09-15-hq-orca-operations-task1-fix2-review.md` records Spec PASS and Quality PASS.
- Task 2: owner-socket claim and loopback cookie/CSRF sessions; SQLite intent/replay journal; real managed runtime wiring; lease-free HQ projections; bounded public Orca reads; exact sender/worker/incarnation gates; native HQ-answer routing. See the Task 2 report and pre-edit-baseline diff; no commit or deployment performed.

- Task 1 fix round 2 addresses the two remaining re-review findings: authoritative public reply/message schemas and target/request identities, a separate bounded source/content worker-read union, nonblank lifecycle states/verdicts, and otherwise-valid receipt-link tests for forbidden and both allowed kinds. The 12 focused tests, 3 selected legacy receipt tests, adapter source/test typechecks, and core test typecheck pass. See `2026-09-15-hq-orca-operations-task1.md` and the explicit-baseline `task1-fix2.diff`; independent review remains.

- Task 1 fix round 1 corrected the first review findings: installed-help-compatible argv, separate bounded project/setup/repo inventory operations, operation-specific receipt schemas with identity checks, preserved HQ event/compaction fields and receipt-link fencing, output-source XOR, bounded inputs, redact-before-truncate behavior, and one-shot overflow termination. Seven focused/impacted test files (73 tests) and core/adapter/installer typechecks passed; re-review subsequently identified incomplete receipt validation and behavioral coverage.

- Read the approved screen-plan `research.md` and `README.md`, the required writing-plans skill, package manifests, and only the narrow HQ progress/runtime, managed HTTP/control, admission/config, installer, web API, and public Orca adapter sources needed to verify contracts.
- Confirmed the public Orca CLI version is `1.4.203`, runtime is ready/reachable/connected, and public help provides run/task/worker reads, bounded worker/terminal output, inbox, dispatch, send/reply, stop/retain/release, and project/worktree/terminal inventory.
- Confirmed `worker-show` keeps `projection.liveness.verdict`, `observation.status`, terminal state, exact-worker evidence, outcome, and resource settlement separate.
- Confirmed HQ context/event reads can use the progress store/control contract without acquiring the single viewer lease, so browser polling can coexist with `hq watch`.
- Confirmed HQ admission capacity defaults to `10`, accepts a positive safe integer or `"unlimited"`, gives config precedence over `HQ_MAX_ACTIVE_WORKERS`, and counts `unknown`, release-pending/unknown, and transferred states as occupied.
- Confirmed the source has no safe live capacity reload/mutation contract. The plan therefore exposes actual limit/occupancy/source and a disabled update capability instead of adding an unsafe config write.

## Plan Shape

1. Shared Zod/sanitization contract and bounded typed public Orca CLI adapter.
2. Trusted loopback bridge, owner-socket claim flow, HQ/Orca projections, durable idempotency/audit, and fresh-state control gates.
3. Real read-first React console covering overview, lists, separate HQ/Orca detail, logs, resources, settings, and evidence.
4. Mutation workflows, `hq console`, safe built-asset serving, Playwright acceptance, and repository validation.
5. Fresh independent integration/security/state review.

Each implementation task names its owner boundary, exact files, produced/consumed interfaces, failing tests, validation commands, atomic commit boundary, and token-efficient model suggestion. The shared contract fixes the supported/deferred split: capacity mutation, token/cost instrumentation, terminal send/close, viewer close, arbitrary retry, and remote browser exposure remain visibly unsupported.

## Ready State

Task 1–3 retain their historical task-scoped PASS reviews. The focused integration fix round 1 re-review closes R1–R5 with Spec PASS / Quality PASS / Overall PASS, subject to its explicit evidence limitations; the original Task 5 BLOCK is historical. No deployment, packaging, or real Orca control was performed by this re-review.
