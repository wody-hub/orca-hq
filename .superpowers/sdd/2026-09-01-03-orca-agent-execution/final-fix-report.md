# Plan 3 final fix report

Date: 2026-09-03
Review input: `final-review-findings.md` against base `0273b8a21f85fec3526db3715a6f497211560fc6`

## Outcome

The final fix wave closes all seven in-scope findings. Verifier acceptance now depends on trusted host evidence, launch retry cannot release fences without exact terminal proof, live execution can be reconstructed from the durable Run graph, terminal receipts and Orca ownership are bound exactly, L0 has a durable terminal state, and worker completion replay is keyed by immutable Dispatch completion identity.

## Finding-to-fix mapping

### Critical 1 — verifier read-only was advisory

Fix:

- Added a strict trusted repository snapshot contract containing repository/worktree identity, HEAD, branch, status hash, diff hash, and audit reference.
- Captured and persisted the baseline before verifier launch, bound its diff hash to the implementation evidence, and compared every trusted identity field before/after (excluding only the audit reference).
- Reordered completion so the exact verifier is authoritatively released before the post-verifier snapshot and host acceptance commands are collected.
- Added an independent durable-store gate that revalidates assignment ownership, implementation diff binding, exact snapshot equality, host command evidence, and terminal release evidence before accepting a verification report.

Regression coverage:

- `uses durable trusted-host snapshots and command evidence to fail closed on verifier mutation`
- `releases the exact verifier before the trusted post-snapshot and host commands`
- `binds verifier snapshots to the implementation diff while allowing a committed implementation HEAD`
- `rejects a verifier baseline whose trusted diff does not match implementation evidence`
- `rejects durable verifier snapshots tampered away from the implementation diff`
- Updated the verifier persistence fixture to include assignment-bound before/after snapshots.

### Critical 2 — launch retry could release attempt-one fences while a worker remained live

Fix:

- Launch failure now performs an authoritative show/read inspection bound to the exact Dispatch, Task, Run, terminal handle, resource ownership, and coherent worker state.
- It then stops that exact Dispatch and accepts only `state: "stopped"` plus `verdict: "stopped"` before cleanup, lease release, or retry.
- The terminal receipt, launch-failure message, Dispatch transition, and audit transition are committed in one immediate SQLite transaction.
- Ambiguous inspection or stop evidence retains the artifact and editing lease and moves the execution to intervention.

Regression coverage:

- `authoritatively inspects and stops the exact possibly-live Dispatch before launch retry cleanup`
- `accepts coherent authoritative launch-failed state evolution before stopping the exact Dispatch`
- `atomically persists authoritative terminal proof with the launch_failed transition`
- `keeps attempt-one fences and intervenes when authoritative launch terminal proof is ambiguous`
- `retains resources when stop verdict does not also report the exact stopped state`

### Important 1 — restart recovery could not resume live implementation, verifier, or Fix completion

Fix:

- Added durable Run-graph loading by either local or Orca Dispatch identity, including Run, all Tasks, all Dispatches, active lease owners, assignments, artifacts, receipts, ancestry, and completion evidence.
- Rebuilt both local and Orca lookup keys, generated verifier/Fix contexts, exact Orca identities, active editing fences, and canonical worker completion audit references during hydration.
- Selected the latest read-write retry placement after restart and reused persisted planned verifier/Fix Dispatches and active Fix leases instead of creating duplicate work.
- Failed closed when a persisted Dispatch lookup is ambiguous.

Regression coverage:

- `resumes a durably planned verifier Dispatch after process loss before launch`
- `reuses a hydrated Fix Dispatch and active lease after process loss before launch`
- `hydrates a complete durable Run graph to resume implementation and verifier worker_done after restart`
- `hydrates canonical completion evidence for every implementation before multi-task verification`
- `hydrates the latest read-write retry placement before launching post-restart verification`
- `hydrates Fix ancestry and exact Dispatch identities through fresh-service cycles one and two`
- `fails closed when an Orca Dispatch lookup key owns more than one Run graph`

### Important 2 — normal release accepted a non-released state/verdict

Fix:

- Runtime release validation now requires the exact Dispatch ID together with `state: "released"` and `verdict: "released"`.
- The durable verification gate independently enforces the same terminal semantics.
- Invalid release evidence is persisted as a release failure; artifacts and leases remain fenced and the Run moves to intervention.

Regression coverage:

- `retains worker and lease fences when release does not authoritatively report released`

### Important 3 — Run, Task, and terminal receipt identities bound too late

Fix:

- Task creation now requires the returned Orca Task to belong to the created Orca Run.
- Provider start now binds local assignment IDs, Orca Task/Run/Dispatch IDs, prompt artifact ownership/content, and the parsed start receipt before the Dispatch can become `running`.
- The initial show/read inspection binds Task, Run, Dispatch, terminal handle/resource ownership, worker state/stage, and read/show coherence before `running` is persisted.
- A start mismatch fences an exact trusted Dispatch when one can be recovered; otherwise it retains local fences and requires intervention.

Regression coverage:

- `rejects an Orca Task receipt that is not bound to the created Run`
- `fences a started Dispatch whose receipt is not bound to the created Run`
- Existing provider receipt validation tests continue to cover exact start and inspection identities.

### Important 4 — L0 investigation completion called empty verification obligations

Fix:

- Added the durable `investigation_complete` Run state.
- Investigation-only Runs now transition directly to that state and never construct implementation verification obligations.

Regression coverage:

- `durably completes an L0 investigation without implementation verification obligations`

### Important 5 — production `worker_done` idempotence differed from tests

Fix:

- Persisted immutable completion identity as Orca Dispatch ID, outcome, and summary, with the canonical first-message audit reference.
- `ControlStore.commitWorkerDone` now deduplicates equivalent fresh-message replays by terminal Dispatch ownership, including verifier Tasks that have advanced to a terminal verification state.
- Missing persisted Orca identity, incoherent terminal Task state, reused message identity, or conflicting immutable completion content fails closed with exported `WorkerCompletionConflictError`.
- Restart hydration restores canonical completion evidence for every completed implementation sibling.

Regression coverage:

- `deduplicates worker_done by Dispatch completion identity across fresh message IDs and rejects conflicts`
- `rejects worker_done when the persisted Dispatch has no exact Orca identity`
- `keeps original worker_done replay idempotent after its obligation advances to a Fix`
- The execution-service tests use the real `ControlStore` for durable replay/conflict cases.

## RED/GREEN evidence

Targeted REDs were observed before the corresponding production behavior was added or restored for verifier release ordering, committed implementation HEAD acceptance, baseline diff mismatch rejection, latest retry placement hydration, launch-failed state evolution, ambiguous graph lookup, exact persisted Orca completion identity, terminal Task coherence, planned-verifier restart, Fix Dispatch/lease reuse, durable snapshot tampering, canonical multi-task completion hydration, persisted-baseline replay with a changed audit reference, and exact stopped state plus verdict.

Each scenario was rerun GREEN after its narrow implementation change. The durable snapshot-tamper test also received a mutation check: removing the persistent implementation-diff binding incorrectly allowed `verified_success`; restoring the binding made the test pass.

The final combined gate exposed one order-sensitive assertion in the new multi-task hydration regression. Both canonical completion records were present, but verifier Task rows that shared the same millisecond `created_at` were returned in the store's documented `created_at, id` order rather than insertion order. For a deterministic RED, the test forces equal verifier timestamps and the prior positional assertion reproduces the reversal. The minimal GREEN keeps the exact length check and asserts unordered membership, which is the actual requirement; production code was unchanged.

After maintenance sleep was eliminated with a bounded long-lived user-active assertion, the root suite exposed an independent harness limit: the adapter's four-operation version/hash case reached 5.012 seconds under normal root-suite parallel load and failed Vitest's default 5-second body timeout. Raising only the body ceiling then exposed the test fixture's separate 5-second client deadline at 5.033 seconds. The minimal test-only GREEN gives normal fake-client operations a 15-second per-process deadline and the multi-process adapter suite a 20-second body ceiling. Dedicated timeout/SIGKILL cases retain their explicit 100 ms and 2-second deadlines, and no production timeout or adapter behavior changed.

Focused and widened regression runs completed as follows:

- Persistence plus execution-service focus: 103/103 tests passed.
- Persistence plus all worker-routing coverage: 182/182 tests passed.
- Root suite: 386/386 tests passed across 19 files.

## Changed files

- `packages/persistence/src/index.ts` — exports the typed completion conflict.
- `packages/orca-adapter/test/capabilities.test.ts` — gives normal fake-client operations a 15-second test-only process deadline and a 20-second Vitest body ceiling without changing production defaults or dedicated timeout cases.
- `packages/persistence/src/store.ts` — durable receipt/snapshot gates, graph hydration query, completion identity dedupe, and atomic launch-failure proof.
- `packages/persistence/test/store.test.ts` — real SQLite completion and ambiguous-lookup regressions.
- `packages/worker-routing/src/execution-service.ts` — exact lifecycle ordering, identity binding, restart hydration, retry fencing, L0 completion, and replay behavior.
- `packages/worker-routing/src/lifecycle.ts` — durable state/data contracts and atomic lifecycle operations.
- `packages/worker-routing/src/providers.ts` — authoritative active-worker and identity-only inspection validators.
- `packages/worker-routing/test/execution-service.test.ts` — end-to-end service regressions for all seven findings and restart cycles.
- `packages/worker-routing/test/verifier.test.ts` — durable verifier snapshot fixtures.
- `.superpowers/sdd/2026-09-01-03-orca-agent-execution/final-fix-report.md` — this report.

## Self-review

- Re-read every final-review finding and traced each required property through runtime validation, persisted evidence, restart behavior, and its regression test.
- Confirmed verifier completion ordering is worker completion → exact release → trusted post-snapshot → host commands → artifact cleanup/lease release → report acceptance.
- Confirmed launch-failure cleanup cannot precede exact inspection and exact stopped proof, and that proof/transition persistence is atomic.
- Confirmed graph recovery restores generated ancestry, the latest editing placement, active leases, both lookup identities, and canonical completion evidence.
- Confirmed exact release/stop state and verdict checks exist both in orchestration and in the durable acceptance gate.
- Confirmed the adapter implementation and production process timeout remain unchanged; only the normal fake-client fixture deadline and adapter suite's Vitest body ceiling changed.
- `git diff --check` passed after the final source/test changes.

## Verification evidence

- `pnpm test`: 386/386 passed, 19/19 files in 10.80 seconds.
- `pnpm typecheck`: passed.
- `pnpm build`: passed across all ten buildable workspace packages.
- `pnpm verify:clean`: passed on the fresh confirmation run; its clean copy ran 386/386 tests in 11.29 seconds and root typecheck, then restored all ten package `dist` directories.
- `git diff --check`: passed.
- The exact combined command exited zero in 29.98 seconds while the bounded `UserIsActive` assertion remained active; `pmset` recorded no sleep event in its 09:19:39–09:20:09 execution window.

The apparent adapter flake had two independent causes. First, `pmset -g log` records a 9-second maintenance sleep beginning at 08:20:29 and a 568-second maintenance sleep beginning at 08:25:54, with dark wake at 08:35:22. The latter exactly matches Vitest's reported 566886 ms duration for the abort case even though the command runner observed only about 12.3 seconds of active wall time. A later combined-gate failure likewise overlaps an 11-second maintenance sleep beginning at 08:55:15: Vitest reported 24.41 seconds while the command runner observed 16.48 seconds, and a normally immediate fake CLI exit crossed its 9-second process timeout. The Mac was on battery in a DarkWake window; `caffeinate -s` is AC-only and the default `-u` assertion expired after five seconds. Second, once a bounded long-lived `caffeinate -u -t` assertion eliminated sleep and clock discontinuity, a different four-operation adapter case reached 5.012 seconds under root-suite parallel load and crossed Vitest's 5-second body ceiling; after raising only that ceiling, its fake child crossed the fixture's independent 5-second process deadline at 5.033 seconds. No fake Orca/Vitest processes or temporary directories remained, and the focused 100 ms production process-timeout case passed in 106 ms. The 15-second normal-fixture deadline and 20-second adapter-scoped body ceiling address only the test harness; final verification also checks the power log for overlapping sleep.

## Remaining concerns

- The review's deferred minor remains: multi-task success notification aggregation still uses the final verifier's evidence rather than a stable Run-level aggregate audit reference. The durable acceptance gate itself covers every obligation.
- Live Codex/Claude/Orca/channel/network E2E and chaos coverage remain assigned to later roadmap plans, as stated in the review scope.
- No unresolved concern remains within the seven-finding final-fix scope.
