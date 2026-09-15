# Native Orca agents — Task 4 result

## Outcome

Task 4 connects managed execution to native Orca Tasks/Dispatches through the existing durable worker admission gate. The native coordinator owns plan persistence, launch progress, Run Delivery processing, questions, result reconciliation, and cleanup accounting. Managed channel work no longer invokes `conversation.execute`; legacy command and agent-tool execution entry points route through native admission, and the alternate external execution composition returns `native_admission_required`.

This is source implementation and isolated regression evidence. Nothing was installed, no service was restarted, no product worker was launched, and no commit, push, new worktree, nested agent, or external channel message was created. The coordinator will run a separate sequential review before proceeding to Task 5.

## Decisions and boundaries

- **Retention:** retain primary workers and release fanout children. The dispatch coordinator selected this as an explicit configurable implementation default in response to the worker's question. It is **not** represented as a previously confirmed user preference. Coordinator options test both cleanup policies; the installed composition selects this default in source only.
- **Capacity:** default 10; `HQ_MAX_ACTIVE_WORKERS` accepts a positive whole number or `unlimited` at startup, parsed by `parseMaxActiveWorkers` at the env-var boundary so an unusable value names the variable and its accepted values instead of an anonymous `TypeError`. The admission constructor remains the authoritative validator. Task 5 still owns the normal configuration file and UI plumbing. Unlimited removes only the capacity wait; resources, dependencies, ownership, and duplicate protection still apply.
- **Planning:** the managed composition converts routed project context into validated Task 1 plans with explicit Codex `gpt-5.6-sol` / `high`. Unqualified work conservatively reserves the primary checkout for writing. Explicit read access and complete additional/external resource declarations are preserved from validated tool ingress. Model/role configuration UX remains Task 5.
- **Existing work:** legacy relay requests drain under their original engine. Legacy resources and cached legacy work block conflicting new admissions. Native observations are not passed into the legacy progress/cleanup adapter.
- **Unknown execution:** launching/unknown attempts remain occupied after restart, and no replacement is automatically launched. Results arriving before a launch can be bound stay in the Delivery journal for recovery. Exact uncertain cleanup receipts are retained; raw `terminal close` is never a recovery fallback.
- **Compatibility limitation:** the external-adapter composition remains available for read/status functions, but its root start, worker-message continuation into verifier work, verification continuation into fix work, launch-failure retry, and external retry control are fenced with `native_admission_required`. It cannot use custom providers to bypass admission. This explicit limitation remains until that composition can share native admission.

## Implementation

### Native coordinator and persistence

`createNativeCoordinator({ planner, admission, relay, store, retentionPolicy })` exposes `execute`, `start`, `close`, and `processDelivery`, plus bounded job projection, guidance, questions, and stop APIs. Plans and trusted source/user identity are persisted before enqueueing. Execution resolves only when required attempts settle, or returns a truthful recovery/failure outcome without releasing unknown occupancy.

`native-journal.ts` shares the progress store's SQLite connection and owner namespace. It stores plans, whole Deliveries, per-message state, questions, guidance, and stop intent. Delivery/message phases are `received`, `applied`, `cleanup_pending`, and `acknowledged`. The whole batch is saved before effects. Result persistence precedes retain/release; successful cleanup is persisted before ack. A duplicate or ack-loss replay uses the already-settled resource verdict and does not clean a terminal that may already have been reassigned.

Message settlement requires the exact Run, Task, Dispatch, and current context generation. Stale completions do not change admission or results. Questions survive reconnect and are exposed in progress with `/answer <message-id> <answer>`; answer intent is durable and retries use one stable per-question mutation identity. Guidance is durable Dispatch inbox mail, with enqueue explicitly distinguished from read/processed status.

Fanout proposals are bounded and validated as a DAG. Children inherit the parent's approved project/resource/profile scope, cannot escalate read access to write, and get deterministic attempt IDs. The planner settles and returns its capacity before children are enqueued. Every child and unrelated request competes at the same admission gate. The legacy conflict predicate is checked inside admission's existing claim transaction.

After restart, occupied attempts are reconciled conservatively before admission opens. A separate lease heartbeat is not blocked by slow CLI calls. Exact settled native results can reconcile a recovery-marked progress request without rerunning its planner or claiming a replacement. Generation and epoch fencing also cover coordinator terminal/Run recovery mutations.

### Runtime and channel integration

`createManagedNativeRuntime` is the shared composition used by the installed runtime and the integration fixture. Substantive execution calls `native.execute`. Context planning uses the Task 2 native executor mode, while resource/capacity ownership remains attempt-based. Same-context changed work queues behind the current turn; completed-context work gets a fresh attempt and Dispatch, with an exact retained-terminal reuse request when eligible.

The original source and user identity are stored with legacy intake and restored into execution; requests are not silently rewritten to terminal/local. Structured submit, review, retry, followup, and tool calls use the same native path. Tool declarations retain all observed checkout and external resource claims without acquiring an obsolete context reservation that would deadlock against native admission. Status and explicit stop remain available.

### Relay and current CLI compatibility

All launch, observation, check, ack, guidance, reply, stop, retain, and release operations use the existing selected CLI transport. Native `check` uses `--terminal` and the exact Run, never `--from`. Ack may return another batch, which remains unacknowledged and is replayed by the next check.

Native mail/cleanup mutation intent and observed Orca request IDs are persisted. Recovery never invents a new mutation identity. Cleanup verifies the exact Dispatch, terminal resource, session/incarnation, and settled state; retain additionally observes idle and retained ownership before returning capacity. Uncertain release preserves the exact response and remains occupied.

Read-only inspection during this task observed CLI **1.4.199**, including its camelCase `worker-show` fields. The native receipt parser now accepts both current camelCase and the previously supported snake_case worker fields. Regression evidence reproduces the original current-CLI rejection before the fix. Read-only help confirmed check, send, reply, retain, and release flags. No installed runtime was modified.

## Acceptance evidence

| Task 4 acceptance | Evidence |
| --- | --- |
| Substantive work launches natively; no hidden conversation execution; no early completion | Managed-runtime fixture drives ordinary channel text through the composition's own `execute` router, observes a native attempt and waits for the worker result, asserts the `/hq ` command port is untouched, and pins the composed surface to `execute`/`native`/`progress` so no conversational path exists to reach |
| Truthful delayed ready event | Coordinator test holds launch receipt; acceptance/launching remain visible and `worker.ready` is absent until the matching receipt |
| Mixed success/question/stale batch | Valid result settles once, question persists, stale Dispatch has no effect, cleanup precedes ack |
| Duplicate/crash/uncertain cleanup | Persistence-before-cleanup replay, ack-loss replay without repeated cleanup, restart replay, exact release/retain tests, no raw close |
| Guidance, followup, changed scope | Durable idempotent inbox mail; same-context changed module request queues; next attempt/Dispatch differs and requests exact retained terminal |
| Fanout and limits | 12-child fanout plus unrelated work at limit 10; unlimited admits independent reads while conflicting writes remain queued; scope/DAG validation |
| Shared channel/admission boundary | Managed-command and agent-tool tests retain source/user and complete declared resources; admission checks legacy conflict before claiming |
| External-adapter bypass | `GATEWAY_EXTERNAL_ADAPTERS` fixture verifies read-only availability and all four execution continuations reject with `native_admission_required` |
| Malformed worker content is quarantined, not wedging | Coordinator tests quarantine an invalid fanout DAG and a poison message beside a valid result: the valid worker settles, the poison sender keeps its slot and is flagged `worker.recovery_required`, the delivery is acknowledged, and the next delivery still flows |
| Restart restores guidance only for verified live workers | Restart test reconciles `active` only when `observeNativeWorker` proves an exact live owned Dispatch; a `live: false` observation stays `unknown`, keeps the slot, and rejects guidance — neither case relaunches. A dedicated relay fixture test proves that observation demands the authoritative `worker-list projection.liveness` verdict on an exactly owned row, not merely a connected PTY |
| Declared read-only scope is never widened | Scope test plans an alias-declared read scope as the canonical project id with `access: "read"` intact, and fails an unmatched scope closed instead of defaulting to a write claim |
| Focused tests and typechecks | Commands/results below |

No known Task 4 acceptance item is left unimplemented. Tasks 5–7, installation, live HQ endpoint/GUI evidence, broader migration acceptance, and independent review remain outside this worker's completion claim.

## Verification

Red-to-green regressions were observed for the absent coordinator, absent native managed composition, external execution fence, current-CLI receipt parsing, restart result reconciliation, coordinator epoch fence, shared managed-command entry, admission's legacy-conflict predicate, and duplicate cleanup after ack loss. Additional focused tests cover channel identity, full resource declarations, fanout, questions, followup, stop, and conservative unknown recovery.

Fresh expanded focused command:

```sh
pnpm exec vitest run apps/gateway/test/native-coordinator.test.ts apps/gateway/test/managed-runtime.test.ts apps/gateway/test/progress-runtime.test.ts apps/gateway/test/relay-coordinator.test.ts apps/gateway/test/managed-commands.test.ts apps/gateway/test/orca-relay.test.ts apps/gateway/test/agent-tools.test.ts apps/gateway/test/entry.test.ts apps/gateway/test/worker-admission.test.ts apps/gateway/test/progress-store.test.ts apps/gateway/test/native-launch.test.ts
```

**11 files, 188 tests passed.**

`pnpm typecheck` — **passed**, including source, root tests, core tests, and installer tests.

`git diff --check -- apps/gateway/src apps/gateway/test` — **passed**.

`pnpm test` — **91 files, 1191 tests passed** (fresh full-suite verification after the review-fix pass and its liveness follow-up; exit 0).

Historical baseline correction: checkpoint **86e3845** had already passed `pnpm typecheck`, **1165 tests**, and `pnpm -r build` in the prior verified session, as supplied in this dispatch. Those are historical results, not fresh Task 4 tests. The old handoff's blanket statement that they had not run was stale. No fresh build or installation was performed in this task.

## Modified files

New:

- `apps/gateway/src/native-coordinator.ts`
- `apps/gateway/src/native-journal.ts`
- `apps/gateway/test/native-coordinator.test.ts`
- `docs/superpowers/implementation/2026-09-15-native-orca-task4-result.md`
- `docs/superpowers/implementation/2026-09-15-native-orca-task4-review.md`

Updated source:

- `apps/gateway/src/managed-runtime.ts`
- `apps/gateway/src/progress-runtime.ts`
- `apps/gateway/src/progress-store.ts`
- `apps/gateway/src/worker-admission.ts`
- `apps/gateway/src/relay-coordinator.ts`
- `apps/gateway/src/orca-relay.ts`
- `apps/gateway/src/native-launch.ts`
- `apps/gateway/src/managed-commands.ts`
- `apps/gateway/src/agent-tools.ts`
- `apps/gateway/src/entry.ts`
- `apps/gateway/src/production.ts`

Updated tests:

- `apps/gateway/test/managed-runtime.test.ts`
- `apps/gateway/test/managed-commands.test.ts`
- `apps/gateway/test/agent-tools.test.ts`
- `apps/gateway/test/orca-relay.test.ts`
- `apps/gateway/test/relay-coordinator.test.ts`
- `apps/gateway/test/worker-admission.test.ts`
- `apps/gateway/test/entry.test.ts`

Updated tracking:

- `docs/superpowers/plans/2026-09-08-hq-native-orca-agents.md`
- `docs/superpowers/implementation/2026-09-09-native-orca-handoff.md`
- `docs/superpowers/implementation/2026-09-08-native-orca-implementation-status.md`

All edits preserve the shared checkout. The prohibited roadmap and its copies were not read, hashed, diffed, staged, restored, or edited.

## Review fixes (2026-09-15, second pass)

The independent review in `2026-09-15-native-orca-task4-review.md` raised one blocker and four
follow-ups; all five are now closed, with per-finding detail and the one reasoned partial
disagreement recorded under that document's **Review resolutions** section.

- **Malformed worker message (blocker).** `apply()` validates each message on its own and journals a
  `quarantine` record with its reason (`native_message_invalid`, `native_message_collision`,
  `native_delivery_collision`, `native_fanout_invalid`) instead of re-throwing. The batch continues,
  the delivery reaches `acknowledged`, and the poll loop keeps fetching. A rejected message never
  releases capacity and never acknowledges away a needed recovery: its owning attempt keeps its slot
  and is flagged `worker.recovery_required`. It deliberately does not `markUnknown`, which would make
  a possibly-healthy worker unguidable.
- **Restart.** `start()` asks the relay for an exact liveness observation before restoring guidance.
  Only `observeNativeWorker(receipt) -> { live: true }` reconciles to `active`; a bound receipt alone,
  a missing capability, a throw, or `live: false` stays `unknown` and emits `worker.recovery_required`.
  `orca-relay.ts` gains that read-only observation, built from the same exactness checks
  `cleanupNative` uses (journal match, dispatch/task/terminal identity, owned + unreleased resource,
  `exactWorker`, connected terminal with matching incarnation, non-terminal dispatch state) **and**,
  on top of them, the authoritative agent verdict. A connected PTY is not evidence of a live agent:
  `worker-show`'s `observation.status` is terminal liveness, while `worker-list`'s
  `projection.liveness` is the fleet verdict for the agent. Reactivation now requires a Run-scoped,
  cursor-paged `worker-list` row that still names this exact receipt (task, run, agent terminal
  handle, `resource.ownerDispatchId`, `ownershipState: "owned"`, `terminalState: "active"`) whose
  `liveness.verdict` is `live`; `exited`, `unverifiable`, an unknown or absent verdict, and a missing
  row all stay `live: false`, so an exhausted listing reads as absence rather than proof of death.
- **Scope.** `agent-tools.ts` builds `nativeScope.projectId` from the resolved `CommandProject`
  explicitly, and the planner resolves the declared selector through the catalog and fails closed
  (`native_scope_project_mismatch`, `native_scope_project_uncovered`) rather than defaulting to a
  `write` claim on the whole checkout.
- **Composition proof.** The unused `conversation` option is removed; `createManagedNativeRuntime`
  owns the whole execute router and returns it, and `startManagedRuntime` calls it instead of
  repeating the `/hq ` ternary, so the tested function is the production one.
- **Capacity env var.** `parseMaxActiveWorkers` validates `HQ_MAX_ACTIVE_WORKERS` at its boundary with
  an actionable message.

Remaining limitations from this pass: `observeNativeWorker` is covered by a dedicated
`orca-relay.test.ts` fixture test whose rows are modelled on read-only inspection of the installed
CLI, but no live agent was driven through a real exit, and only `liveness.verdict` is inspected, not
`liveness.source`; a message whose own `taskId`/`dispatchId` are malformed is quarantined with no recovery event
and is visible only via `quarantined()`, since no operator-facing quarantine surface exists yet
(Task 5 scope); and `native_scope_project_uncovered` fails a multi-project context under a
single-project scope rather than partially planning.

Second-pass files: `apps/gateway/src/native-coordinator.ts`, `apps/gateway/src/orca-relay.ts`,
`apps/gateway/src/managed-runtime.ts`, `apps/gateway/src/agent-tools.ts`,
`apps/gateway/test/native-coordinator.test.ts`, `apps/gateway/test/managed-runtime.test.ts`, plus this
document and the review document. The finding-2 liveness follow-up additionally touched
`apps/gateway/src/orca-relay.ts` and `apps/gateway/test/orca-relay.test.ts`. No install, restart, commit, push, new worktree, nested agent, or
product-worker launch was performed, and Tasks 5-7 were not touched.

## Dispatch provenance

Task `task_d2c2e12a0cf6`, Dispatch `ctx_6d7984383bc1`, worker terminal `term_5931918e-70fc-4a93-8534-ef02ef4133ec`, coordinator terminal `term_d5d08c72-3c2b-4429-8425-8b7d1327388d`, existing checkout `/Users/j.jaeyo/Project/ETC/orca-hq`. Executing-plans and its verification/finishing workflow were applied within the explicit no-commit/no-install/no-new-worktree constraints; integration is left to the coordinator.
