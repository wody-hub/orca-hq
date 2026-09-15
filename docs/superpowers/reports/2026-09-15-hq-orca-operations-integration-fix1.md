# HQ + Orca Operations Console — integration fix round 1

Date: 2026-09-15 KST  
Status: **Independent R1–R5 re-review: Spec PASS / Quality PASS / Overall PASS**

## Outcome

This round implements only the five findings in `2026-09-15-hq-orca-operations-integration-review.md`. The focused independent disposition and remaining limitations are recorded in `2026-09-15-hq-orca-operations-integration-fix1-review.md`; the original BLOCK report remains historical.

## Pre-edit baseline and preservation boundary

- The companion `.diff` is a descriptive scope ledger, not an applicable patch or a machine-verifiable pre-edit delta. The following baseline account is the implementer's record; no immutable pre-edit source snapshot was supplied or reconstructed by the reviewer. Current-source inspection and regressions establish current behavior, not exact attribution of edits in this shared overlay.
- Workspace root mode was `0755` before editing and remains `0755` after validation.
- The checkout was already shared and dirty. The explicit allowlist showed tracked modifications in the web API/app and Orca capability files, while the operations routes, gateway controls/tests, adapter operations test, E2E fixture, and progress report were pre-existing untracked overlay files.
- Edits were limited to the operation-specific allowlist recorded below. No unrelated change was restored, staged, committed, or overwritten.
- The prohibited 2026-09-01 private-pilot roadmap and copies were not read, hashed, diffed, staged, restored, or edited.

## Corrections

### R1 — durable browser-session ambiguity fence

- Added an app-owned mutation registry keyed by action plus logical target identity. Pending and unknown entries retain one request ID across tab and route unmounts within the mounted app lifetime; unsubmitted reservations may be cleared on consumer unmount. Reload/new-tab persistence is not implemented.
- Unknown and pending entries are never evicted. The registry is capped at 128 entries and refuses a new operation when unresolved entries fill the bound; it does not mint a replacement ID or retry automatically.
- Harmless worker/detail refreshes do not reconcile or clear unknown results. Accepted/rejected entries can be removed on consumer unmount or evicted when reserving at capacity.
- Receipt request-ID mismatches become a fenced unknown result using the original request ID.

### R2 — native terminal handle

- The browser resource contract and tree now use native terminal `handle`, matching the adapter receipt and gateway projection.
- The combined smoke feeds a real `OperationsService.resources()` HTTP response into `orcaResourcesSchema`; no fixture alias is inserted at that boundary.

### R3 — bounded current-question snapshot

- Overview, Questions, and Evidence share a cancellable ten-request question snapshot reader.
- The reader follows cursor advancement even when a filtered page is empty, performs a second stable pass to reconcile questions resolved during the first traversal, and reports compacted/changing/budget-exhausted coverage as partial.
- Partial coverage suppresses authoritative “no questions” copy. Regression coverage exercises a pending question after cursor 100 on all three screens, resolved-question reconciliation, and the traversal bound.

### R4 — reviewed typed injection

- Compose exposes a boolean `inject` choice and repeats the exact value in the review dialog.
- Gateway input is strict and requires a boolean; the adapter operation union carries the boolean and adds exactly one `--inject` only when true.
- UI copy states that low-level dispatch remains unsupervised and does not create `worker-start` supervision or resource ownership. No raw argv is accepted from the browser.

### R5 — combined real-boundary smoke

- Added one isolated test crossing an owner-only `0700` temporary directory, `0600` Unix control socket claim, real loopback HTTP listener, single-use claim, cookie, exact Origin, CSRF, strict route input, SQLite operations journal, `OperationsService`, `OperationsOrca`, and an executable fake Orca process with captured argv.
- It proves native resource parsing, a positive injected dispatch, Origin/CSRF rejection, pre-effect stale-incarnation rejection, accepted replay deduplication, unknown replay deduplication, and a held viewer lease that remains live.
- The unknown case is a real fake child process started for the dispatch effect and exiting with code 75. The managed HTTP process remains alive; afterward the test performs an orderly service stop, closes SQLite, reopens the database, and verifies accepted/rejected/unknown rows. This is meaningful effect-process interruption evidence, but it is **not** a whole managed-service process crash simulation.
- Only the fake executable is invoked; no real Orca mutation is performed.

## Verification

- RED, web: `apps/web/src/app.test.tsx` — 7 expected failures out of 25 covered later-page questions on three screens, partial coverage, native handle rendering, route/tab unknown fencing, and inject review.
- RED, gateway/adapter: 3 expected failures across 53 tests covered strict gateway inject and exact adapter argv.
- Focused GREEN: web/API **46 tests / 2 files**; gateway/adapter/combined smoke **55 tests / 3 files**.
- Focused production typechecks: web, gateway, and strict Orca adapter source — exit 0.
- Full root suite: **1,336 tests / 105 files passed**.
- Full root build: **15 of 16 workspace projects**, including web **42 transformed modules**, passed.
- Full root source/test typecheck passed, including core and installer test configs.
- Web Playwright: **4 Chromium cases passed** across 1440, 1280, 390, and interaction/control coverage. The runner emitted only its existing `NO_COLOR`/`FORCE_COLOR` environment warning.

## Exact changed-file scope

- `apps/web/src/api.ts`
- `apps/web/src/app.tsx`
- `apps/web/src/operations-state.ts`
- `apps/web/src/routes/operations-compose.tsx`
- `apps/web/src/routes/operations-detail.tsx`
- `apps/web/src/routes/operations-evidence.tsx`
- `apps/web/src/routes/operations-overview.tsx`
- `apps/web/src/routes/operations-questions.tsx`
- `apps/web/src/routes/operations-resources.tsx`
- `apps/web/src/app.test.tsx`
- `apps/web/e2e/operations-console.spec.ts`
- `apps/gateway/src/operations-controls.ts`
- `apps/gateway/test/operations-service.test.ts`
- `apps/gateway/test/operations-integration.test.ts`
- `packages/orca-adapter/src/capabilities.ts`
- `packages/orca-adapter/test/operations.test.ts`
- this report, its scoped overlay ledger, and the operations progress report

No install, packaging, production restart, commit, push, or real control was performed.
