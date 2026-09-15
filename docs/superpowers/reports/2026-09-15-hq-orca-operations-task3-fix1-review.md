# Task 3 fix round 1 independent review

Date: 2026-09-15 KST
Spec: **PASS**
Quality: **BLOCK**

## Scope and evidence

- Reviewed the Task 3 review, fix report, fix overlay, live changed frontend files, and only the exact gateway/core projections needed to verify S1/S2/Q1/Q2/Q3. Task 4 controls, launcher/static serving, and browser E2E remain out of scope.
- Reused the implementer's recorded `@orca-hq/web` **30 passing tests / 2 files**, typecheck, and build (39 modules). No broad test rerun, install, browser session, or real Orca control mutation was needed; the remaining blocker is established directly by the request-state transitions below.
- Native Run `objective` and inbox `subject`/`body` correctly remain unbounded per field in the client (`apps/web/src/api.ts:66,72`), matching the native projections (`apps/gateway/src/operations-projections.ts:19-25,89-100`) while the Orca execution and HTTP response paths retain the outer **2 MiB** bounds (`apps/gateway/src/operations-orca.ts:41-50`; `apps/gateway/src/operations-http.ts:74-80`).

## Spec assessment — PASS

### S1 — PASS: observed Orca questions are no longer actionable pending attention

- The actionable count now includes only authoritative HQ questions and unknown/unverifiable workers (`apps/web/src/routes/operations-overview.tsx:14-16`). Orca inbox questions render separately as observed history, and the UI exposes the backend's unsupported pending-state reason (`apps/web/src/routes/operations-overview.tsx:27-31`).
- This agrees with the gateway contract, which filters observed question messages but explicitly returns `pendingState.supported:false` because inbox has no authoritative pending state (`apps/gateway/src/operations-service.ts:380-391`). The focused regression asserts a historical question does not increment attention (`apps/web/src/app.test.tsx:52-59`).

### S2 — PASS: native Run and Task records are inspectable and remain separate from Dispatch

- `/work` renders a source-tagged native Run table, loads Tasks only after a Run is selected, and keeps the Dispatch table separate (`apps/web/src/routes/operations-list.tsx:10-12,92-98`). The API uses the existing `GET /api/operations/orca/tasks?runId=...` route and preserves native Task fields (`apps/web/src/api.ts:19-20,67,79,91`).
- The route validates `runId`, invokes the native `list_tasks` read, and returns at most 100 native Task projections without synthesizing them from workers (`apps/gateway/src/operations-service.ts:240-246,595-596`). The focused UI test verifies lazy Run-scoped Task loading (`apps/web/src/app.test.tsx:61-70`).

## Quality assessment — BLOCK

### Q1 — PASS for the original stale-read finding

- Log requests now carry an AbortSignal and generation fence, abort on source replacement, hidden state, route identity change, and unmount, and ignore late settlement (`apps/web/src/routes/operations-detail.tsx:49-73`). Pagination requests use the same signal/fence pattern and abort on hidden/unmount (`apps/web/src/routes/operations-list.tsx:25,51-56,61-89`).
- Focused coverage verifies signal forwarding and stale terminal output suppression after a source switch (`apps/web/src/api.test.ts:108-114`; `apps/web/src/app.test.tsx:121-135`).

### Q2 — PASS for exhaustion and first-page invalidation

- First-page signatures include cursor/compaction plus row identity; unchanged polls preserve an exhausted cursor chain, while changed pages clear appended rows, restore the new cursor, advance the generation, and abort obsolete page work (`apps/web/src/routes/operations-list.tsx:30-49,58-60`). HQ contexts and Orca workers are deduplicated independently (`apps/web/src/routes/operations-list.tsx:59-60`).
- Focused regressions cover poll-after-exhaustion and removal of an appended stale page after first-page replacement (`apps/web/src/app.test.tsx:83-108`).

### Q3 — PASS: response validation now follows the published limits and discriminants

- The manual parsers enforce 512-character IDs, 2048-character cursors, 64 KiB public text, strict UTC ISO timestamps, positive sequence/generation values, the declared HQ event-kind union, and receipt-link kind fencing before values reach React (`apps/web/src/api.ts:44-59,64-74`). The added table-driven cases cover over-bound cursor/ID/text, non-contract date, and unknown event kind (`apps/web/src/api.test.ts:71-100`).
- Native Task fields use the gateway's snake_case projection, while intentionally unbounded native Run/inbox text relies on the already enforced outer 2 MiB response limit rather than inventing a per-field rejection.

### New Q4 — P1: a first-page refresh can permanently strand pagination in `loading`

- `loadMore` sets `pageState` to `loading` before awaiting its page requests (`apps/web/src/routes/operations-list.tsx:61-75`). If the independent 5-second first-page poll changes either signature while that request is pending, the reconciliation effect increments the generation and aborts the page controller (`apps/web/src/routes/operations-list.tsx:33-49`).
- The aborted/stale continuation returns without restoring `pageState`, and the catch deliberately skips state updates for an aborted or superseded request (`apps/web/src/routes/operations-list.tsx:76,86-89`). Unlike the visibility handler, the signature-change path never calls `setPageState("ready")` (`apps/web/src/routes/operations-list.tsx:51-55`).
- The load-more control consequently remains disabled and labeled “읽는 중” forever (`apps/web/src/routes/operations-list.tsx:98`), even though the obsolete request was safely cancelled and the refreshed first page is ready. The current regressions refresh only after pagination has already settled, so they do not cover this interleaving (`apps/web/src/app.test.tsx:83-108`).
- Reset pagination state when reconciliation supersedes a request, without letting the obsolete continuation overwrite a newer request, and add a focused deferred-request regression where a changed first-page poll wins while load-more is in flight.

## Disposition

S1, S2, Q1, Q2, and Q3 are fixed as originally requested, so the Task 3 feature contract receives **Spec PASS**. Quality remains **BLOCK** on the deterministic pagination cancellation/state-machine defect introduced in the fix; Task 4 work is not required to resolve it.
