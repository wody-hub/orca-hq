# HQ Context Progress Runtime Integration Review

Status: **FINDINGS RESOLVED AFTER REVIEW**. The findings below preserve the original review. All six were corrected and verified; see `2026-09-08-progress-runtime-fixes.md`, `2026-09-08-progress-relay-fixes.md`, and the final `2026-09-08-progress-verification.md` report.

Reviewed the approved context-progress design against the current runtime integration, including the native mutation boundary and the focused unit, end-to-end, and restart tests. The default five-context limit, sixth-context FIFO behavior, same-context turn serialization, known-dispatch reservation retention, and independent-context failure isolation are covered and currently pass. The findings below are correctness issues not exercised by those tests.

## Findings

### 1. [P1] Retry reacquires only the primary checkout, not the original complete resource set

Confidence: 10/10

Evidence:

- `apps/gateway/src/agent-tools.ts:47-54` defines `jobs.retry` with only `jobId`; there is no resource declaration or persisted resource-set token.
- `apps/gateway/src/agent-tools.ts:861-865` sends retry and worker-spawning followup through `beforeNative(a.jobId)`.
- `apps/gateway/src/progress-runtime.ts:459-473` implements that path as `await reserve([{ resourceKey: job.worktreePath, mode: "write" }])`; it reacquires only the job's primary checkout.
- `apps/gateway/src/managed-runtime.ts:99-113` authorizes native launch when the actual primary checkout is covered by any current reservation; it does not prove ownership of the original secondary checkouts or external mutation targets.

Reproduction: run a native job with primary checkout A, additional checkout B, and `external:E`, let it fail so the original reservation is released, then retry it while another context holds B or E. The retry claims only A and passes the actual `worker-start` authorization even though the retried prompt can repeat mutations against B/E. This breaks the design's atomic all-resource reservation contract and permits concurrent editors/effects on undeclared retry resources.

Required correction: persist the normalized complete resource set as native-attempt provenance and require retry and worker-spawning followup to reacquire that entire set atomically. If provenance is absent or ambiguous, retain/reject for recovery rather than launching with primary-checkout ownership alone.

### 2. [P1] A legacy retry can inherit stale progress ownership and disappear from the coexistence guard

Confidence: 9/10

Evidence:

- `apps/gateway/src/orca-relay.ts:834-843` omits `execution` from a retry record when a legacy caller retries a previously progress-owned task.
- `apps/gateway/src/orca-relay.ts:375-379` spreads the previous cached job, but only overwrites `execution` when the latest delivery has one; it never clears stale execution provenance when the latest delivery is legacy.
- `apps/gateway/src/execution-compatibility.ts:22-26` excludes every cached job with `job.execution` from legacy conflict detection.

Reproduction: allow a progress-owned dispatch to fail and release its reservation, then retry that task through the legacy command path. The new retry record has no execution ownership, but the refreshed running snapshot retains the prior progress `execution`; `hasLegacyConflict()` therefore ignores the live legacy worker, allowing a new progress context to reserve the same checkout after the legacy launch boundary has passed.

Required correction: derive snapshot ownership from the exact current native attempt/delivery. A delivery without `execution` must explicitly clear stale execution provenance, and compatibility classification should use attempt/dispatch provenance rather than an inherited task-level field.

### 3. [P1] A crash in the persisted `worker_sent` window leaves unknown native ownership queued forever

Confidence: 9/10

Evidence:

- `apps/gateway/src/orca-relay.ts:605-611` persists `phase = "worker_sent"` before awaiting `worker-start`, and persists `observed` only after the receipt returns.
- `apps/gateway/src/orca-relay.ts:891-913` restarts background launch only for `task_created`; any record with a `taskId` in `worker_sent` merely calls `get()`.
- `apps/gateway/src/orca-relay.ts:403-408` exposes an uncertainty warning only for phase `unknown`. For scoped retries, `apps/gateway/src/orca-relay.ts:535-543` maps non-observed `worker_sent` to `queued`, not `recovery_required`.

Reproduction: terminate the process after line 607 persists `worker_sent` and before `worker-start` returns. If the native launch did not take effect, restart observes a task with no dispatch, never relaunches it, and never converts the record to recovery-required; progress startup treats the cached job as nonterminal and retains its context slot/reservation indefinitely. If launch did take effect, later observation can find it, so automatic replay is also unsafe—the state is genuinely unknown until reconciled.

Required correction: on startup, reconcile `worker_sent` against exact dispatch/attempt provenance. Mark unresolved ownership `unknown`/`recovery_required` and retain reservations without replay; only move to observed after proving the dispatch identity.

The existing `apps/gateway/test/orca-relay.test.ts:182-211` test covers a thrown lost response that the live catch block persists as `unknown`; it does not cover process death while the call is pending.

### 4. [P1] Multipart failure finalizes every context with the aggregate failure, before siblings settle

Confidence: 10/10

Evidence:

- `apps/gateway/src/progress-runtime.ts:83-100` emits the same completion kind, derived solely from the aggregate request state, to every assigned context.
- `apps/gateway/src/progress-runtime.ts:733-801` uses `Promise.all`; its rejection handler completes the aggregate request immediately on the first thrown part, while sibling parts continue running.

Reproduction: route one request into contexts A and B, make B throw immediately, and keep A executing before it succeeds. The aggregate catch emits `recovery.required` to both context viewers before A finishes; A's later success does not revise the already-rejected aggregate promise. Even without a throw, if one part returns `state: "failed"` and the other succeeds, `complete()` emits `request.failed` to the successful context as well.

Required correction: track a durable outcome per assignment, await all parts with `Promise.allSettled`, emit each context's final event from its own outcome, then emit one aggregate result after every part settles. Preserve assignment order in the aggregate text and identify partial success versus unknown effects explicitly.

### 5. [P2] Native guidance is serialized behind unrelated native creation/retry calls

Confidence: 9/10

Evidence:

- `apps/gateway/src/orca-relay.ts:218` creates one process-global `serial` chain, and `apps/gateway/src/orca-relay.ts:635-643` appends each serialized mutation to it.
- `apps/gateway/src/orca-relay.ts:737-750` routes both `submit` and `followup` through that same chain; retry uses it at `apps/gateway/src/orca-relay.ts:816-821`.
- `apps/gateway/src/progress-runtime.ts:634-640` awaits `controlJob` for guidance, while `runOrca` can wait up to 75 seconds at `apps/gateway/src/orca-relay.ts:181-184`.

Reproduction: stall context A's native `task-create`, then issue `/guidance` for context B's already-running worker. The guidance followup queues behind A's unrelated serialized mutation and the control request cannot complete or reach B for up to the transport timeout. Status and stop bypass this particular chain, but guidance does not meet the approved responsive-control contract.

Required correction: keep exact-once serialization scoped to the mutation identity/task, while giving guidance to an already-known dispatch an independent bounded control lane. Preserve per-request idempotency without a global head-of-line blocker.

### 6. [P2] The approved 30-day detail-retention policy is not wired into production

Confidence: 10/10

Evidence:

- The design requires completed-request detail retention for 30 days while preserving executing, awaiting-input, and recovery-required history.
- `apps/gateway/src/progress-store.ts:1214-1250` exposes `pruneCompletedEvents(before)`, but the only non-definition call found is the manual compaction assertion in `tests/e2e/context-progress.spec.ts:217`.
- The production timer in `apps/gateway/src/progress-runtime.ts:963-972` drains requests and heartbeats reservations only; `apps/gateway/src/managed-runtime.ts:170-195` supplies no retention scheduler.

Impact: completed detail grows without bound in production. Wiring the current method blindly is also unsafe for a long-running native worker because the runtime deliberately marks the HQ request completed while its context/worker remains active (`tests/e2e/context-progress.spec.ts:120-137`), whereas the store pruning predicate currently keys only on request state.

Required correction: add bounded periodic retention scheduling and make the eligibility check preserve details for contexts with active or recovery-required native ownership even when the initiating HQ response is already `completed`. Keep request receipts, snapshots, final summaries, job IDs, and compaction watermarks as designed.

## Verified behavior and test evidence

- `apps/gateway/test/context-executor.test.ts:9-35` verifies five independent contexts, sixth FIFO admission, and same-context serialization.
- `apps/gateway/test/context-executor.test.ts:37-54` and `tests/chaos/context-progress-restart.spec.ts:11-60` verify retention of a known/unknown native slot and a persisted reservation when a dispatch is already recorded.
- `apps/gateway/test/progress-runtime.test.ts:13-105` verifies stale completion cannot release a later request's reservation; `apps/gateway/test/progress-runtime.test.ts:231-303` verifies a known native dispatch survives model failure.
- `tests/e2e/context-progress.spec.ts:58-98` exercises the five-context and same-context queue through the real control socket; `tests/e2e/context-progress.spec.ts:187-207` confirms independent-context failure isolation.
- Focused verification passed: 44 tests across the six scoped gateway test files, plus 6 tests across the context-progress end-to-end and restart suites.

Missing coverage aligns with the findings: no test covers mixed outcomes inside one multipart request, secondary/external retry resources, a crash while `worker-start` is pending after `worker_sent` is durable, a legacy retry of a progress-owned task, guidance behind an unrelated stalled native mutation, or production retention scheduling.

## Scope assessment

The implementation materially satisfies the five-context limit and same-context turn ownership, and it conservatively retains known ambiguous native reservations. It is not ready to claim the full approved runtime contract until the P1 provenance/partial-failure defects are corrected and the P2 responsive-control/retention gaps are addressed with the missing integration and crash-window tests.

## Coordination status

These findings describe the source snapshot reviewed before concurrent corrections. The coordinator accepted all six findings: the active runtime owner was assigned findings 1, 4, and 6, while findings 2, 3, and 5 were reserved for a subsequent bounded relay/compatibility fix dispatch. This report does not claim those corrections are already present or verified.
