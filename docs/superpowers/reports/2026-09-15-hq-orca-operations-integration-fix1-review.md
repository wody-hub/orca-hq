# HQ + Orca Operations — focused integration fix 1 re-review

Date: 2026-09-16 KST  
Spec: **PASS**  
Quality: **PASS**  
Overall: **PASS**

R1–R5 are addressed in the inspected current source. This supersedes those five blockers in `2026-09-15-hq-orca-operations-integration-review.md`; it is not a new broad security or feature audit. Code remained read-only.

## Exact evidence

| Finding | Verdict | Inspected implementation and regression evidence |
|---|---|---|
| R1 — mutation identity lifetime | PASS | `apps/web/src/app.tsx:37,49` owns the registry above keyed routes; `operations-state.ts:27,54,69` retains pending/unknown IDs, fences receipt-ID mismatches, and refuses overflow at 128 entries. `routes/operations-compose.tsx:21,25,35,50` consumes shared state and cleans up only resolved/unsubmitted entries; `operations-detail.tsx:94–95` uses action/Dispatch keys. `app.test.tsx:296` asserts unknown stop → evidence → state → route departure/return, same visible ID, disabled control, and one effect; `:117` asserts pending/unknown capacity retention. |
| R2 — native terminal handle | PASS | `apps/web/src/api.ts:73` parses `handle`; `routes/operations-resources.tsx:10` keys/renders it, and the E2E fixture uses it. `apps/gateway/test/operations-integration.test.ts:179–183` parses actual service HTTP resource output with `orcaResourcesSchema` and asserts native `target` handle; gateway `operations-service.ts:474–486` preserves the terminal projection. |
| R3 — current questions | PASS | `apps/web/src/operations-state.ts:85–118` follows advancing cursors across empty filtered pages, checks/passes AbortSignal, limits two scans to ten requests, replaces first-pass questions with second-pass results, and marks changed/compacted/incomplete coverage partial. Overview, Questions, and Evidence all call it and suppress authoritative empty copy for partial coverage. `app.test.tsx:71–115` covers cursor 100 on all three consumers, exhausted budget, and resolution between passes. |
| R4 — typed inject | PASS | `routes/operations-compose.tsx:73,80–81` defaults false, exposes/reviews the boolean, sends it, and states unsupervised/no resource ownership semantics. `apps/gateway/src/operations-controls.ts:62,138–147,340` strictly requires/passes a boolean before journal/effect. `packages/orca-adapter/src/capabilities.ts:57,159` validates and emits exactly one `--inject` for true, none for false. Adapter `test/operations.test.ts:11–16,35–41` asserts exact argv and invalid type; gateway `operations-service.test.ts:321` rejects missing/string values without effects; web `app.test.tsx:321` asserts reviewed true/body. |
| R5 — combined smoke | PASS | `apps/gateway/test/operations-integration.test.ts:125` joins actual owner Unix claim, 0700 directory/0600 socket, loopback HTTP, single-use claim/cookie, Origin/CSRF, SQLite journal, service, actual `OperationsOrca`, and fake executable. Assertions cover native browser parser (`:179`), positive injected dispatch and accepted replay (`:188`), auth denial (`:185`), stale-incarnation denial (`:192`), unknown and equal replay (`:196`), surviving held viewer lease (`:203`), exactly two captured effect argv (`:204`), and persisted accepted/rejected/unknown rows after reopen (`:214`). No real Orca effect is involved. |

Paths abbreviated in the table are relative to their preceding package. Existing hooks and gateway question/resource/process wiring were read only to trace these fixes; the earlier positive security audit remains unchanged.

## Verification and documentation accuracy

- Reused the candidate's recorded results: **1,336 root tests / 105 files**, **46 web/API tests / 2 files**, **55 gateway/adapter/smoke tests / 3 files**, **4 Chromium E2E cases**, full build and source/test typechecks. These are prior runs, not fresh executions by this reviewer.
- One fresh in-memory Node probe transpiled the actual `operations-state.ts` without writing source: pending and unknown entries survived `clearResolved` with identical IDs, a full unresolved registry refused another entry, and an aborted traversal made exactly one API call with no continuation. All assertions passed; no broad suites were rerun.
- Corrected the candidate report and `.diff`: the latter is a **descriptive ledger**, not an applicable patch or machine-verifiable pre-edit delta. No immutable pre-edit snapshot was supplied, and none was fabricated. Current source/tests substantiate behavior; they do not establish exact edit attribution.

## Remaining limitations

- Mutation fences live in one mounted App, surviving its route/detail-tab changes. They do not persist across reload, another browser tab, or a new App; unknowns have no automatic reconciliation/retry. At capacity only settled non-unknown receipts may be evicted; unresolved entries block new reservations. The durable server journal deduplicates reuse of the same request ID.
- Question scans are bounded observations, not an atomic snapshot or unlimited backlog reader. First-pass exhaustion can return partial after five calls; compaction or a changed terminal cursor also prevents a complete claim. Questions/Evidence withhold actionable rows while partial; Overview can show observed rows with a partial warning. The second pass reconciles previously resolved questions but does not freeze concurrent state changes.
- The combined smoke uses injected dispatch; false is covered by exact adapter argv assertions. Its fake child exits 75 (`:147`), then the service/SQLite close and reopen orderly. This proves unknown effect handling and persisted receipts, not whole-service crash recovery during an effect or real agent delivery. Held-lease proof is a surviving lease heartbeat, not a concurrently running `hq watch` process. Browser E2E remains fake-API coverage.

No remaining blocker was found within R1–R5. Only this review, candidate report/ledger, and progress report were edited; no code fix, install, packaging, commit, push, production restart, or real control occurred. The prohibited roadmap and copies were not accessed; unrelated changes were preserved and workspace root mode remained **0755**.
