# Progress Relay Fixes

## Scope

Implemented accepted runtime-review findings 2, 3, and 5 in the native relay boundary. Production changes are confined to `apps/gateway/src/orca-relay.ts`; `execution-compatibility.ts` required no logic change because it already classifies every active cached job without `execution` as legacy once the relay publishes the current attempt correctly.

## Fixes

### Current-attempt legacy ownership

- Native snapshots now derive execution ownership from the latest worker-launch attempt rather than the latest message delivery.
- A legacy retry explicitly removes inherited progress `execution` ownership and is immediately persisted as `queued`/`retry_pending` without the previous dispatch ID.
- This makes the retry visible to `listActiveCached()` before `worker-start`, so the existing legacy/progress compatibility guard covers the authorization-to-observation handoff as well as the running worker.
- Message-only guidance does not replace worker-launch provenance, so guidance for a progress-owned dispatch does not accidentally reclassify that worker as legacy.

### `worker_sent` crash-window reconciliation

- Startup converts a durable `worker_sent` record to explicit unknown ownership before any native observation and never replays `worker-start`.
- The cached job is immediately fenced as `recovery_required`/`worker_start_outcome_unknown`, so native transport unavailability cannot leave a queued-looking slot indefinitely.
- A later observation promotes the launch record only when its dispatch ID was already persisted with `launchOwned: true` from a successful `worker-start` receipt and the observed ID matches exactly.
- A receipt-less crash or lost response remains recovery-required even if the task later exposes a different dispatch; task-level observation alone never grants cleanup ownership. For retries, the previous `retryOf` dispatch is likewise never accepted as proof of the new attempt.

### Responsive known-worker guidance

- A cached running job with a known dispatch uses an independent per-task guidance lane instead of the process-global native creation/retry chain.
- Guidance remains serialized in order for the same task, and an in-flight request-ID map preserves idempotency for concurrent duplicates.
- If live revalidation shows the worker has already settled, the operation falls back to the normal global serialized worker-creation path.
- Shutdown waits for active guidance requests, and every routed call still resolves the current coordinator through the existing recovery callback.

## Regression evidence

Each behavioral test was observed failing before the corresponding production change:

1. `clears progress ownership when a legacy retry becomes the current native attempt` initially received the prior `{contextId, requestId, generation}` and the old failed snapshot instead of an ownership-free queued retry.
2. `marks a persisted worker-sent crash window unknown when reconciliation is unavailable` initially retained `queued`/`pending` after restart.
3. `does not adopt a task-level dispatch after losing the worker-start response` initially changed the receipt-less attempt to running and implicitly acquired ownership of `dispatch-1`.
4. `delivers known-worker guidance while unrelated native creation is stalled` initially timed out with no native `send` while the unrelated `task-create` held the global chain.

The positive proof case is separately covered by `reconciles only an exact dispatch ID already persisted as launch-owned`. A mutation that disabled the exact-owned reconciliation branch made that test fail with `recovery_required` instead of the proven `dispatch-1`, confirming the test exercises the ownership proof rather than merely native task status.

All four now pass. Existing retry warning behavior remains intact for a live legacy transport failure: the prior native failure stays visible with its delivery warning instead of being incorrectly converted to scoped progress recovery.

## Verification

- `pnpm exec vitest run apps/gateway/test/orca-relay.test.ts apps/gateway/test/execution-compatibility.test.ts` — 2 files, 24 tests passed.
- `pnpm exec vitest run apps/gateway/test tests/e2e/context-progress.spec.ts tests/chaos/context-progress-restart.spec.ts` — 37 files, 297 tests passed, including the concurrently updated progress runtime/store integration.
- `pnpm typecheck` — root source, test projects, core, and installer typechecks passed.

## Remaining work

No implementation work remains for findings 2, 3, or 5. The coordinator retains responsibility for the consolidated post-merge verification with the separately owned findings 1, 4, and 6 changes.
