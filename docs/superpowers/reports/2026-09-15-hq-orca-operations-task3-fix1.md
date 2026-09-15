# Task 3 fix round 1 — S1/S2/Q1/Q2/Q3

Date: 2026-09-15 KST
Status: implemented and focused verification passed; independent re-review pending

## Implemented fixes

- **S1:** Orca inbox questions remain observed history only. They no longer increase the actionable attention count, and the overview displays the backend's explicit unsupported pending-state reason.
- **S2:** `/work` now renders native Run rows and loads the selected Run's native Task rows on demand through `GET /api/operations/orca/tasks?runId=...`; Run, Task, and Dispatch stay separate.
- **Q1:** Output-tab and list-pagination requests carry AbortSignals, abort on unmount/hidden/source replacement, and use generation fences so late responses cannot update the current route/source.
- **Q2:** First-page signatures preserve an exhausted pagination chain across unchanged polls, but changed cursor/compaction/row identity resets appended pages and aborts obsolete pagination work. HQ and Orca page results remain independently deduplicated.
- **Q3:** Dependency-free response validation now enforces actual Task 2/core ID, cursor, context text/state, ISO date, positive-sequence/generation, event-kind/link, public output, and receipt bounds. Native Run objective and inbox subject/body remain compatible with their actual unbounded-per-field schemas and the server's 2 MiB response cap.

## TDD and verification

- Red: **12 targeted failures / 18 passes** established over-bound cursor/ID/text/date/event acceptance, missing native Task support, question-state overclaiming, cursor resurrection/stale page retention, and output abort/race defects.
- Green: `pnpm --filter @orca-hq/web test` — **30 tests / 2 files passed**.
- `pnpm --filter @orca-hq/web typecheck` — passed.
- `pnpm --filter @orca-hq/web build` — passed; Vite transformed **39 modules** and emitted local HTML/CSS/JS assets.

## Changed paths and boundary

- Frontend: `apps/web/src/api.ts`, `api.test.ts`, `app.test.tsx`, `routes/operations-overview.tsx`, `operations-list.tsx`, and `operations-detail.tsx`.
- Reports: this report, `2026-09-15-hq-orca-operations-task3-fix1.diff`, and the progress entry.
- The overlay diff is based only on explicit pre-edit copies under `/tmp/orca-task3-fix1.p0Snrj`; it does not use a whole-worktree diff.
- No Task 4 controls/launcher/E2E, backend, dependency, protected document, unrelated artifact, commit, push, install, production restart, or real Orca mutation was performed.

## Handoff

Independent Task 3 fix re-review should verify S1/S2/Q1/Q2/Q3 against this report and overlay. Task 4 remains pending and out of this round.
