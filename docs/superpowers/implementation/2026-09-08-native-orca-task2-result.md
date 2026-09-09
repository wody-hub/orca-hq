# Native Orca agents — Task 2 result

## Outcome and scope

Task 2 implements durable SQLite native worker admission using the existing `@orca-hq/persistence` connection owned by `SqliteProgressStore`. Capacity, attempt-owned resource acquisition, FIFO selection, native receipts, conservative cleanup accounting, restart reconciliation, and coordinator epoch fencing are implemented and verified. No runtime launch wiring, configuration UI, installation, build, service restart, commit, push, new worktree, or subworker was performed; legacy execution retains its existing default policy until Task 4 explicitly selects native mode.

The original allowlisted contents were copied before edits to:

`/var/folders/0c/w6zr1lls7nggx4f19l5dxf4h0000gn/T/orca-task2-originals-mj_aht_5`

`manifest.json` identifies original files and paths that did not yet exist. The protected roadmap was never read, hashed, diffed, staged, restored, or edited. Coordinator owns all plan checkbox changes.

## Admission API

```ts
const admission = createWorkerAdmission({
  store,
  maxActiveWorkers: 10, // optional; positive safe integer or "unlimited"
  leaseTtlMs: 30_000   // optional coordinator lease, not a resource TTL
});
```

The equivalent store factory is `store.createWorkerAdmission(options)`. Its returned closure is the public native mutation boundary; raw database access is not exposed. Internal migration/construction helpers share the existing store connection and do not create another persistence backend.

| Method | Contract |
| --- | --- |
| `enqueue(item)` | Validates the Task 1 schema, normalizes all resource keys, checks trusted request/context assignment and current generation, and assigns a durable FIFO sequence. Identical normalized replays are no-ops; changed attempt identities fail. Sibling attempts may share a context and generation, including distinct assigned requests. |
| `claimNext()` | Returns a `NativeWorkItem` or `undefined`. A single `BEGIN IMMEDIATE` transaction checks the coordinator epoch, recovery barrier, global capacity, dependencies, and every resource, then persists launching occupancy and all claims before returning. |
| `bindReceipt(receipt)` | Requires an admitted attempt and exact worktree/requested profile/resume-terminal match. Persists the full validated receipt; changed Dispatch/receipt or occupied terminal ownership is rejected. Exact replays are no-ops. |
| `settle(attemptId, dispatchId, outcome, resourceVerdict)` | Returns `false` without changing attempt state for a stale Dispatch or stale context generation. `outcome` is `succeeded`, `failed`, or `stopped`. Matching duplicate outcomes are idempotent; contradictory outcomes fail. |
| `markUnknown(attemptId)` | Holds occupancy and every resource indefinitely. Never revives a settled attempt or launches a queued one. |
| `snapshot()` | Read-only `{ active, queued }`, counted by attempt across channel/session/context identities. |
| `listAttempts()` | Read-only durable FIFO records with item, state, complete/null receipt, outcome, resource verdict, claim epoch, and reconciliation epoch. Supplies recovery inspection data. |
| `beginRelease(attemptId, dispatchId)` | Persists `release_pending` before external cleanup; stale Dispatch returns `false`. Capacity and resources remain held. |
| `reconcile(attemptId, observation)` | Trusted relay recovery boundary. Accepts `{state: "active", dispatchId}`, `{state: "unknown"}`, or `{state: "settled", dispatchId, outcome, resourceVerdict}`. Active/settled observations require the exact persisted Dispatch; active requires a bound receipt. Unknown observations hold all resources. |
| `finishReconciliation()` | Opens admission only after every occupied persisted attempt has been observed in this coordinator epoch (or proven settled). Otherwise throws `reconciliation_required`. |
| `heartbeat()` | Renews the current coordinator lease while idle. Throws `coordinator_fenced` if expired or superseded. |
| `close()` | Relinquishes the coordinator lease without releasing workers or resources. Store connection closure alone does not relinquish a live lease. |

Resource verdict accounting:

| Verdict/phase | Capacity | Resource ownership |
| --- | --- | --- |
| `released` | Returned | Released |
| `retained_idle` | Returned | Released for reacquisition; the receipt remains durable |
| `transferred` | One occupied attempt remains | All claims remain held; transfer is not interpreted as disappearance |
| `unknown` | Remains occupied as `release_unknown` | All claims remain held |
| `release_pending` | Remains occupied | All claims remain held |
| Launching/active/unknown | Remains occupied | All claims remain held; no TTL release |

The default limit admits 10 and queues the 11th. A limit of 12 admits 12 and queues the 13th. Unlimited removes only the capacity branch; resource exclusion, dependency ordering, identity checks, leases and reconciliation still apply. Lowering 12 to 10 preserves all 12 existing attempts and blocks new claims until active occupancy is below 10.

FIFO is maintained among dependency-ready, generation-valid candidates. A blocked writer prevents conflicting later readers/writers from overtaking it; unrelated candidates may proceed. Unmet dependencies do not reserve queue priority against their own prerequisites. Resource claims are all-or-none, include secondary checkouts/external resources, and use attempt identity rather than context identity. A requested retained terminal is reserved exclusively at claim time, before launch effects; freshly observed terminals are reserved atomically with receipt binding.

## Ownership and recovery

There is one admission coordinator per trusted HQ database owner, independent of channel/session identity. Startup acquires a monotonically increasing epoch and random ownership token transactionally. A second live scheduler receives `coordinator_owned`; after expiry a replacement acquires the next epoch. Every mutation, including enqueue, claim, receipt binding, settlement, unknown/cleanup transitions, reconciliation, heartbeat and close, checks the epoch/token/lease inside its write transaction. Read-only snapshots remain available to a fenced observer. Expiry never changes attempt occupancy.

Any occupied attempt at coordinator acquisition closes the durable admission barrier. Task 4 must inspect `listAttempts()`, obtain exact Task 3 relay observations, call `reconcile` for each occupied attempt, and then call `finishReconciliation`. Conservatively acknowledging an unknown observation permits unrelated admission only within remaining capacity and resource constraints; it never frees the unknown worker. Merely reopening the database or binding a receipt does not open the barrier.

Normal completion is fenced against the current context generation. Authoritative cleanup reconciliation can release an older-generation attempt using exact persisted Dispatch evidence, without completing or modifying the newer generation's request. This distinction prevents stale results from becoming current completion while still allowing old resources to be cleaned up.

## Legacy boundary

- `createContextExecutor({ mode: "native" })` sequences planning turns within a context but imposes neither the five-context capacity policy nor a one-native-worker-per-context limit. The default remains `legacy` until Task 4 runtime wiring.
- Native resources have a read-only projection through `listExecutionReservations()`. Legacy reservations block native admission and native claims block legacy reservations on overlapping resources; existing compatibility polling sees unknown native external resources too.
- Legacy release/heartbeat APIs cannot mutate native attempt claims. Only admission methods write native lifecycle state.
- `pruneCompletedEvents()` now excludes requests holding native occupied attempts, preserving recovery evidence even after the request result is recorded. Once resources are proven released/retained idle, ordinary event compaction resumes while receipt/attempt rows remain durable.

## Verification

TDD evidence:

1. Initial Task 2 focused run failed at the absent admission module and native executor's existing five-context/one-worker guards.
2. Store/reservation/compatibility integration tests failed at the absent `createWorkerAdmission` store API.
3. After implementation, the initial focused set passed 57 tests.
4. Added coordinator-review regressions failed on stale-generation settlement and premature pruning of native recovery events; an additional test failed on concurrent retained-terminal reacquisition.
5. A restart regression failed when an active reconciliation observation carried a stale Dispatch, then passed after adding exact Dispatch validation.

Final fresh checks (2026-09-08, 20:30 KST):

```sh
pnpm exec vitest run apps/gateway/test/worker-admission.test.ts apps/gateway/test/context-executor.test.ts apps/gateway/test/execution-reservations.test.ts apps/gateway/test/execution-compatibility.test.ts apps/gateway/test/progress-store.test.ts
```

**5 files passed, 62 tests passed**: worker admission 28, context executor 4, reservations 6, compatibility 2, progress store 22. This includes a real simultaneous two-thread SQLite scheduler ownership/claim contention test using separate connections, a barrier, and the public store admission factory; only one scheduler acquires ownership and claims one attempt at capacity 1. Its test-only source loader uses the installed TypeScript package and source aliases without rebuilding stale declarations, installing tools, or exposing shareable scheduler tokens.

```sh
pnpm exec tsc -p tsconfig.json --noEmit --pretty false
```

Passed using root source aliases. Standalone gateway declarations were neither rebuilt nor used to mask their pre-existing staleness.

An explicit allowlisted `git diff --check` passed for the eight modified existing source/test files. New files were reviewed directly. No full suite or repeated broad audit was run.

## Scope decisions and remaining integration

- Kept the legacy executor default unchanged and added explicit native mode, resolving the Task 2 removal requirement against the instruction to preserve existing runtime behavior until Task 4.
- Added the recovery/lease inspection methods above because the plan's six minimal methods cannot express a checked restart barrier, idle lease renewal, or a persisted release-pending phase. These are bounded Task 2 lifecycle additions.
- Task 3 must supply truthful receipts and exact release/retain/transfer observations. An admitted attempt with no receipt remains occupied even if a caller suspects that no launch happened. **There is intentionally no receipt-free release escape hatch.** Before production integration, Task 3 must define a typed, authoritative no-launch recovery proof and its admission transition for a claimed attempt proven never launched; callers must never fabricate a Dispatch/receipt to free capacity. Until such proof exists, conservative unknown/recovery remains the safe behavior.
- `transferred` preserves the original occupied attempt; Task 3/4 must resolve the exact transfer ownership before freeing it. A new attempt must not be used to evade a still-occupied transferred terminal.
- Task 4 owns coordinator lifecycle, trusted reconciliation calls, channel submit/retry/fanout wiring, legacy job conflict checks, provider backoff policy, dependency/result aggregation, and switching context planning to native mode. The new gate does not launch workers or bypass existing provider policies.
- Task 5 owns startup configuration plumbing and the selected retain/release policy. Current tests exercise both explicit released and retained-idle accounting.
- No installed/native end-to-end behavior is claimed by this Task 2 result.

## Modified paths

- `apps/gateway/src/worker-admission.ts` (new)
- `apps/gateway/test/worker-admission.test.ts` (new)
- `apps/gateway/src/progress-store.ts`
- `apps/gateway/test/progress-store.test.ts`
- `apps/gateway/src/context-executor.ts`
- `apps/gateway/test/context-executor.test.ts`
- `apps/gateway/src/execution-reservations.ts`
- `apps/gateway/test/execution-reservations.test.ts`
- `apps/gateway/src/execution-compatibility.ts`
- `apps/gateway/test/execution-compatibility.test.ts`
- `docs/superpowers/implementation/2026-09-08-native-orca-task2-result.md` (new)

## Coordinator closeout

Actual Orca provenance: Run `run_31b08e55c07d`, Task `task_1604f911c834`, Dispatch `ctx_ab477a5dcb34`, Codex `gpt-6-astra` / `high`, terminal `term_142f9ef5-a855-4c98-8674-a9350cab71f1` in the existing HQ checkout. Coordinator reviewed source changes against the allowlisted pre-edit snapshot and verified final test/typecheck output from the attested worker transcript. No outstanding Task 2 review findings remain; the typed no-launch transition is explicitly assigned to Task 3 before production integration.

Orca accepted `worker_done` as succeeded. `worker-release` returned `released`, `closed_agent_terminal`, and transcript `captured`; completion Delivery `delivery_bd995c871bbf` was acknowledged after release, with no pending messages. Task 2 plan checkboxes are complete; Task 3 onward remain pending.
