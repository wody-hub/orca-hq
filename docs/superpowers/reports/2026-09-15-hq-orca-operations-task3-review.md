# Task 3 independent spec and quality review

Date: 2026-09-15 KST
Spec: **BLOCK**
Quality: **BLOCK**

## Scope and evidence

- Reviewed the Task 3 report/diff, final Task 2 route matrix and actual response projections, the frontend read paths/tests, and only Global Constraints, Shared Contract, and Task 3 of the approved implementation plan.
- Reused the recorded **19 passing tests / 2 files**, typecheck, build, and local-asset check; they were not rerun or represented as fresh review results. Static file/line evidence was sufficient for the findings below, so no browser, runtime, install, or real mutation probe was run.
- Compose, reply, lifecycle controls, launcher/static serving, and browser E2E remain correctly assigned to Task 4 and are not findings here.

## Required fixes

### S1 — P1: Unverifiable Orca question state is promoted to actionable attention

- Task 2 deliberately returns only observed question messages and `support.pendingState.supported:false`, because public inbox cannot establish whether a question is still pending (`apps/gateway/src/operations-service.ts:380-391`).
- The overview nevertheless adds every Orca question message to `attention`, labels the result “관심 필요,” and says an empty total means no waiting attention (`apps/web/src/routes/operations-overview.tsx:15-30`). An old or answered inbox question is therefore presented as needing action despite the explicit evidence limit.
- Keep observed inbox-question count/history separate from actionable or pending attention, and surface the unsupported pending-state evidence wherever that distinction drives UI state. The questions screen's explanatory copy is honest; its Task 4-disabled reply control is not the issue.

### S2 — P1: The approved Run/Task read view is missing

- The shared contract and Task 2 matrix expose separate Run, Task, and Dispatch reads; the Task 3 plan requires these records to stay separate rather than be synthesized. The work screen itself claims it lists “Run/Task/Dispatch” (`apps/web/src/routes/operations-list.tsx:26`).
- In practice the API has no task-list or Run-detail method (`apps/web/src/api.ts:71-72,84`), and `/work` renders only a Run count plus Dispatch rows (`apps/web/src/routes/operations-list.tsx:15-17,29`). Operators cannot inspect any native Task record or even Run objective/identity rows.
- Add read-only, source-tagged Run and Task coverage within the approved `/work` experience using the existing Task 2 routes. This does not require Task 4 compose/dispatch controls.

### Q1 — P1: Route/visibility cancellation does not cover log and pagination reads

- Hook-owned initial reads and polling abort on unmount/hidden state (`apps/web/src/hooks.ts:15-23,31-46`; `apps/web/src/routes/operations-detail.tsx:13-32`).
- Orca log tab reads call `api.output` without a signal and keep no per-request generation (`apps/web/src/routes/operations-detail.tsx:43-63`). Fast terminal/transcript switching can let an older response overwrite the selected source, and navigation/hidden state leaves the request alive.
- List pagination also calls `api.contexts`/`api.workers` without a signal or lifecycle guard (`apps/web/src/routes/operations-list.tsx:22-25`). Abort stale/on-hide reads and ignore responses whose route, source, or generation is no longer current.

### Q2 — P2: First-page polling resurrects consumed cursors and stale appended rows

- Every 5-second list poll overwrites the pagination cursors from page one (`apps/web/src/routes/operations-list.tsx:14-18`) while `moreContexts`/`moreWorkers` remain accumulated (`apps/web/src/routes/operations-list.tsx:10-13,20-21`).
- After the last page clears its cursor, the next poll restores the old first-page cursor, so the same page can be requested indefinitely. Removed/compacted records also remain in the appended arrays even when the refreshed first page no longer supports them.
- Reconcile/reset the accumulated page chain when the first page refreshes, or keep an explicit cursor chain whose terminal/exhausted state polling cannot overwrite. Add a regression covering poll-after-exhaustion and changed/compacted first pages.

### Q3 — P2: Runtime response validators do not enforce the published bounds/discriminants

- The backend contract bounds IDs to 512, cursors to 2048, display text to 64 KiB, and HQ event kinds to the declared discriminant (`packages/core/src/operations.ts:11-16,66-83`).
- The client `text` helper accepts any nonempty string, cursor fields reuse it, `iso` accepts any `Date.parse` input, and event `kind` is only nonempty text (`apps/web/src/api.ts:39-53,56-67`). This contradicts the report's claim that required bounds and discriminants are validated before React.
- Keep the dependency-free parser if desired, but encode the actual native/backend limits and discriminants and add malformed over-bound cursor/ID/text, non-contract date, and event-kind cases. No dependency rewrite is required.

## Verified assessment

- HQ and Orca records are visually source-tagged; actual Task 2 native Run snake_case and worker/detail shapes are consumed without manufacturing Run status. Claim fragments are synchronously removed before validation/network settlement, refresh is read-only and coalesced while in flight, and mutations do not enter the read recovery path.
- Completion-scheduled overview/list and HQ-event polling avoid overlap; HQ events advance monotonically, deduplicate by sequence, bound retained rows, preserve compaction indication, and link only receipt-backed Dispatch IDs.
- Output source discrimination, transcript ID deduplication, accepted-versus-completed wording, unavailable metrics, unsupported capacity updates, auth guidance, and distinct loading/empty/disconnected/error/unknown components are present. Resource hierarchy conveys project coverage and truncation, though deeper omission evidence should remain visible when the view is refined.
- The Task 4 placeholders are deliberate and correctly non-mutating. No additional Task 3 blocking defect was established beyond S1/S2/Q1; Q2/Q3 remain important quality corrections before this task is called complete.

## Disposition

Fix S1/S2/Q1 and add focused regressions; correct Q2/Q3 in the same frontend review round. Only this review and the progress review entry were edited; no code, protected document, unrelated artifact, commit, installation, browser session, or runtime mutation was performed.
