# Native Orca agents — Task 4 independent review

**Scope:** uncommitted Task 4 changes only, reviewed against Task 4 of
`../plans/2026-09-08-hq-native-orca-agents.md` and the worker's
`2026-09-15-native-orca-task4-result.md`. Read-only source review; the only file written is this one.
Allowlisted diffs only: `apps/gateway/src/{native-coordinator,native-journal,managed-runtime,managed-commands,agent-tools,entry,production,orca-relay,relay-coordinator,progress-runtime,progress-store,native-launch,worker-admission}.ts`
and the matching `apps/gateway/test/*`. No broad `git diff`, no worktree/install/restart/commit/push, no external messages.

## Conclusion

**Conditional pass with 1 blocker.** The structural Task 4 claims hold up under source review: managed channel work
no longer reaches `conversation.execute`, the legacy relay mutation entry points are fenced behind
`native_admission_required`, delivery/message/question/guidance state is durable, cleanup is persisted before ack,
settlement is fenced on exact Run/Task/Dispatch/generation, and fanout children inherit and cannot escalate the
parent's scope. Two things are overstated in the result report and one delivery-loop defect is a genuine Task 4
blocker: a single malformed worker message permanently wedges the whole coordinator and leaks that worker's
capacity slot forever. Everything else below is a bounded fix inside Task 4's own files; nothing found belongs to
Task 5–7 scope that Task 4 should have covered.

Verified independently (source, not the worker's test counts): I did not re-run the suite — the defects below are
static and the existing tests encode rather than contradict them. One suspected blocker (worktree-id shape) was
**disproved** by a read-only `orca worktree ps --json`: real Orca worktree ids are literally `repoId::path`, so the
`${projectId}::${absolutePath}` synthesis in `managed-runtime.ts` and every `indexOf("::")` slice in
`native-coordinator.ts` / `orca-relay.ts` are consistent with `validateNativePlacement` (`orca-relay.ts:1073`).

## Findings

### 1. BLOCKER — one malformed worker message permanently wedges the delivery loop and leaks its capacity slot

**Where:** `apps/gateway/src/native-coordinator.ts:127`, `:130`, `:166`, `:210-215`

**Trigger:** `apply()` persists the delivery at `:127` with phase `received`, then runs `MessageSchema.parse(raw)`
at `:130` and `children(item, message.fanout)` at `:166`. Both throw on worker-authored content:

- `outcome` outside `succeeded|failed|stopped` (e.g. a worker reporting `cancelled`);
- any extra key in a fanout entry — the inner object is `.strict()` (`:15`), and `taskSpec()` in
  `orca-relay.ts` instructs workers to emit `{id, objective, access, dependsOn}` free-form, so one added
  `reason`/`notes` field is enough;
- `fanout.length > 128`, `objective.length > 8000`, a duplicate/unknown/cyclic fanout id (`:112`, `:117`, `:120`).

Because the delivery is already journaled, `tick()` (`:210-215`) replays it on every poll and throws **before**
`relay.checkDelivery()` is reached. No delivery for any worker is ever fetched again, and the offending attempt
stays `active` — `markUnknown`/`settle` are never called, and occupied attempts have no TTL release
(`worker-admission.ts` `OCCUPIED`). One bad worker therefore takes down native execution for the whole gateway and
burns a permanent slot out of the default 10.

The existing test `native-coordinator.test.ts:93-101` asserts exactly this shape (`rejects.toThrow`, no cleanup,
no ack, `active` still 1) and stops there, so it codifies the wedge instead of catching it.

**Expected fix:** validate each message individually. On a validation failure, journal the message as
`{ ignored: true, phase: "applied" }`, emit `worker.recovery_required` with the rejected payload, and let the
batch continue to cleanup/settle/ack — or accept the `worker_done` and drop only the invalid `fanout`. Deliveries
must never be able to reach a phase the coordinator can only re-throw on. The same applies to
`native_delivery_collision` (`:125`) and `native_message_collision` (`:132`), which wedge identically; those are
genuine integrity faults, but they should quarantine the delivery and surface it, not stall the loop.

### 2. MEDIUM — restart downgrades every receipt-bound live worker to `unknown`

**Where:** `apps/gateway/src/native-coordinator.ts:299-305`

**Trigger:** `start()` binds a verified receipt from the relay journal (`:302`, proving launch and identity) and
then unconditionally calls `admission.reconcile(a.item.attemptId, { state: "unknown" })` for every non-queued,
non-settled attempt. A healthy `active` worker becomes `unknown` after any gateway restart.

**Consequence:** `projectJob` reports `recovery_required` (`:67`); `guidance()` rejects with
`native_guidance_requires_active_worker` because it requires `state === "active"` (`:276`); `nativeExecute` in
`managed-runtime.ts` rejects followups with `native_previous_attempt_unsettled`; an in-flight `execute()` returns
`recovery_required` (`:237`). The worker can still deliver its result (settlement from `unknown` is legal), so
`native-coordinator.test.ts:134-146` passes — but the worker becomes unguidable and unfollowable for the rest of
its life, which contradicts the plan's "preserved task/terminal identity" intent for restart.

**Expected fix:** when the relay journal yields a verified receipt, reconcile as
`{ state: "active", dispatchId: receipt.dispatchId }` — `worker-admission.ts:380-389` already supports and
validates that observation. Reserve `unknown` for receipt-free attempts, which is the conservatism Task 2/3
actually asked for. Add a restart test that asserts `guidance()` still succeeds.

### 3. MEDIUM — declared read-only scope silently becomes a full write claim on an alias

**Where:** `apps/gateway/src/agent-tools.ts:857`; `apps/gateway/src/managed-runtime.ts` (planner `proposedItems`)

**Trigger:** `agent-tools.ts:857` builds `nativeScope.projectId` from `a.project`, the *selector* the model typed.
`catalog.resolve()` accepts aliases, so the selector need not equal the resolved `project.id`. The planner then
matches on identity — `access: scope?.projectId === a.projectId ? scope.access : "write"`, and the same ternary for
`resources`. On any alias, the carefully declared `access: "read"` + enumerated resources are silently discarded
and replaced by a `write` claim on the entire primary checkout.

**Consequence:** a review request takes an exclusive write claim, blocking every other worker on that checkout, and
the declared external/secondary resources vanish from the reservation. Latent today because `createAgentTools` is
only wired into the now-unused conversation agent, but the path is live through `commands.execute`.

**Expected fix:** resolve the selector to a catalog id before constructing `nativeScope` (or match on the resolved
id in the planner), and fail closed — `throw` on an unmatched scope rather than defaulting to `write`.

### 4. MEDIUM (evidence quality) — the "no hidden conversation execution" proof is vacuous

**Where:** `apps/gateway/src/managed-runtime.ts:99` (option declared), no reference in the function body;
`apps/gateway/test/managed-runtime.test.ts` (`expect(conversation.execute).not.toHaveBeenCalled()`)

`createManagedNativeRuntime` accepts a `conversation` option and never uses it, so the throwing spy the plan asked
for is unreachable by construction and the assertion cannot fail. The underlying claim is still true — I verified
by inspection that `conversation` in `startManagedRuntime` is now only constructed and closed (lines 294, 383, 393),
and that `execute` routes to `commands.execute` / `progress.executeLegacy` — but the acceptance row in the result
report is not carried by this test.

**Expected fix:** drop the unused option and assert the absence structurally (e.g. that `startManagedRuntime`'s
composition exposes no conversation execute path), or actually thread the spy through a fallback so the test can fail.

### 5. LOW — `HQ_MAX_ACTIVE_WORKERS` typo crashes startup with an opaque `TypeError`

**Where:** `apps/gateway/src/managed-runtime.ts` (`Number(configuredLimit)`); validated at
`apps/gateway/src/worker-admission.ts:156-158`

The admission constructor is a real validator (contrary to nothing in the report — this part is accurate), but
`Number("ten")` reaches it as `NaN` and the gateway dies at boot with
`maxActiveWorkers must be a positive safe integer or "unlimited"` and no mention of the env var. Parse and report
at the env-var boundary. Configuration UX proper is Task 5 scope; only the message is Task 4's.

## Confirmed as claimed

- **Actual input to native execution.** `execute()` requires `input.execution` and rejects otherwise (`:219`);
  plans are persisted before enqueue (`:226`) and re-validated against `requestId`/`contextId`/`generation`
  (`:224`) and against `inputKey`/`source`/`userId` on replay (`:227`, `:245`). The objective carries the real
  user text plus the context summary; nothing is rewritten to a synthetic prompt.
- **No hidden conversation fallback.** `entry`/`startManagedRuntime` route `/hq ` to `commands.execute` and
  everything else to `progress.executeLegacy` → `native.execute`; `orca-relay` fences `submit`, `followup` and
  `retry` behind `nativeOnly`; `production.ts:660-666` blocks the four `ExecutionService` mutation entry points
  (`start`, `recordWorkerMessage`, `recordVerificationReport`, `recordLaunchFailure` — I checked the class and
  these are the only non-read-only public ones; `inspectWorker` is read-only), and `entry.ts` blocks
  `dispatchControl.retry`. The external-adapter fixture in `entry.test.ts` exercises this with
  `GATEWAY_EXTERNAL_ADAPTERS` set.
- **Epoch/generation/identity validation.** Every mutation goes through `fence()`/`admission.heartbeat()`; message
  settlement requires an exact `runId`+`taskId`+`dispatchId` receipt match plus `current()` generation (`:140`,
  `:150`); `settle` re-checks `dispatch_id` and receipt presence and returns `true` on replay without resurrecting
  released ownership (`worker-admission.ts:209-222`); stale completions are journaled `ignored` and change nothing.
- **Cleanup and ack-loss replay.** Result is persisted before `cleanup_pending`, cleanup before `settle`, settle
  before ack (`:165-199`); a settled attempt short-circuits to its recorded verdict on replay (`:174`) so cleanup
  is not repeated; `durableNativeEffect` in `orca-relay.ts` persists the observed Orca request id and never invents
  a retry identity. Uncertain verdicts keep the slot occupied and emit `worker.recovery_required` rather than
  closing a terminal raw.
- **Retained terminal reuse.** `retained_idle` is only returned after `worker-retain`, a `tui-idle` wait and a
  re-read confirming `releaseState`/`ownerDispatchId`/`terminalHandle`/incarnation; the planner reuses that exact
  `terminalHandle` only for a settled `retained_idle` attempt with an identical profile (`managed-runtime.ts`
  planner `prior` filter).
- **Channel/user authority.** Origin (`source`, `userId`, `nativeScope`) is journaled per request in
  `progress-runtime.ts:executeLegacy` and restored into the executed input, with a `request_origin_collision`
  guard; the plan record independently rejects a `source`/`userId` change.
- **Questions.** Durable, survive reconnect, surfaced as `clarification.required` with `/answer <id>`, and the
  answer uses one stable mutation identity (`key("answer", messageId)`) with collision detection.
- **Fanout.** Children inherit the parent's project/resource/profile scope, downgrade write→read, cannot escalate
  (`:114`), are validated as a DAG by `NativeWorkPlanSchema`, and are enqueued only after the planner has already
  released its own slot (`:187`), so there is no wait-for-child deadlock. They compete on the same gate as
  unrelated work.
- **Legacy drain.** `hasLegacyConflict` is now evaluated inside `claimNext`'s claim transaction
  (`worker-admission.ts` `canClaim`), legacy jobs that are native-owned are filtered out of the compatibility view,
  and `notify`/`onUpdate` suppress native-owned jobs from the legacy progress/cleanup adapter.

## Scope boundaries

All five findings live in Task 4's own files. Not Task 4's to fix: `maxActiveWorkers` configuration file/UI and
model-role UX (Task 5); the `executionBackend` discriminator, seeded-SQLite migration fixtures, real-socket
restart and live 10+1 concurrency evidence (Task 6); installation readiness and GUI evidence (Task 7). The report's
own "no installation, restart, commit, push, new worktree, nested agent, or product-worker launch" statement is
consistent with the working tree I reviewed.

## Recommendation

Fix finding 1 before Task 5 — it is a whole-gateway availability defect reachable from ordinary worker output, and
its current test locks in the wrong behavior. Findings 2 and 3 are cheap and belong with it. Finding 4 should be
resolved before the Task 4 acceptance row is treated as evidence.

## Review resolutions — 2026-09-15 (implementation pass)

All five findings were reproduced against the working tree before any change; each fix below is
carried by a test that fails without it. Fresh full suite after the pass: **91 files, 1191 tests
passed**; `pnpm typecheck` passed.

| # | Verdict | Resolution |
|---|---------|------------|
| 1 | Confirmed, fixed | Per-message validation and durable quarantine in `apply()`; a rejected message never re-throws. |
| 2 | Confirmed, fixed | Restart reconciles to `active` only on a verified live, exactly-owned receipt; everything weaker stays `unknown`. |
| 3 | Partly disputed, fixed | The alias trigger was already closed at `agent-tools.ts:819`; the planner's fail-open `write` default was real and is now fail-closed. |
| 4 | Confirmed, fixed | The unused `conversation` option is gone; the composition now owns the whole execute router and the test drives it. |
| 5 | Confirmed, fixed | `HQ_MAX_ACTIVE_WORKERS` is parsed at the env-var boundary with an error naming the variable and its accepted values. |

### 1 — malformed worker message (BLOCKER)

`native-coordinator.ts` `apply()` now validates each message on its own. A message that fails
`MessageSchema` is journaled as a `quarantine` record (`native_message_invalid`) with the raw payload
and reason; a contradicting redelivery (`native_delivery_collision`) and a contradicting message
(`native_message_collision`) quarantine the same way instead of throwing. An invalid `fanout`
proposal quarantines as `native_fanout_invalid` and leaves the accepted `worker_done` result intact,
so the parent still cleans up, settles and acks. The batch continues; the delivery reaches
`acknowledged`, so `tick()` no longer replays it ahead of `relay.checkDelivery()`.

A rejected message never releases capacity and never acknowledges away a needed recovery: the
sender's attempt keeps its slot, and `flagRejected` attributes the rejected envelope to its owning
attempt (exact `runId`+`taskId`+`dispatchId`) and emits `worker.recovery_required` for it. It
deliberately does **not** call `markUnknown` — the worker may still be alive, and downgrading it
would make it unguidable, which is exactly finding 2's defect.

Tests (`native-coordinator.test.ts`): the stale
`validates fanout DAG and scope before settlement or ack` — which codified the wedge — is replaced by
`quarantines an invalid fanout DAG without rejecting the accepted result or stranding the slot`, and
a new `quarantines a poison message beside a valid result and keeps the next delivery flowing` puts
an out-of-enum `outcome: "cancelled"` for worker A in the same batch as a valid `worker_done` for
worker B: B settles, A stays `active` and is flagged for recovery, the delivery is acknowledged, the
poll loop keeps calling `checkDelivery`, and A's next delivery settles normally.

### 2 — restart downgraded a live worker

`start()` binds the journaled receipt as before, then asks the relay for an exact liveness
observation. Only `observeNativeWorker(receipt) → { live: true }` reconciles to
`{ state: "active", dispatchId }`; a missing capability, a throw, or `live: false` reconciles to
`unknown` and emits `worker.recovery_required`. A bound identity alone is explicitly not accepted as
live proof, per the dispatch constraint (this is stricter than the review's suggested fix).

`orca-relay.ts` gains a read-only `observeNativeWorker` built from the same exactness checks
`cleanupNative` uses: `exactNative(receipt)` journal match, then `worker-show --dispatch` must agree
on dispatch id, task id, terminal handle, owner dispatch, `ownershipState === "owned"`, a
non-released/non-retained release state, `observation.exactWorker === true`, a connected terminal
whose incarnation matches the launch journal, and a non-terminal dispatch state. Anything else
returns `{ live: false, recovery: observed }`. It performs no mutation.

Test: `restores guidance after restart only for a verified live owned receipt` restarts twice over
the same store — once with `live: false` (state `unknown`, slot still occupied, `guidance()` rejects
with `native_guidance_requires_active_worker`) and once with `live: true` (state `active`,
`guidance()` succeeds) — with no relaunch in either case.

**Follow-up correction (evidence gap closed).** The first pass proved liveness from `worker-show`
alone, which is wrong: per the current Orca orchestration guide, `worker-show`'s `observation.status`
is *PTY* liveness, while `worker-list`'s `projection.liveness` is the authoritative fleet verdict for
the agent. A connected terminal can hold a dead or stuck agent, so the first pass could have
reactivated a worker that had already exited. `observeNativeWorker` now requires both: the exact
ownership gate above on `worker-show`, and then a Run-scoped `worker-list` row that still names this
exact receipt (task, run, agent terminal handle, `resource.ownerDispatchId`, `ownershipState:
"owned"`, `terminalState: "active"`) whose `projection.liveness.verdict` is `live`. `exited`,
`unverifiable`, an unknown or absent verdict, a missing row and every ownership mismatch return
`live: false` with both observations as recovery. The listing is paged by `page.nextCursor`, and an
exhausted listing is treated as absence, never as proof of death.

`orca-relay.test.ts` now carries the dedicated fixture test
`reactivates a restart only on an exactly owned receipt plus an authoritative live agent verdict`,
which holds the PTY live in every case so only the authoritative row can explain a `live: false`:
true for the exact owned live row (including when it is on a later page), false for
`exited`/`unverifiable`/`unknown`/absent verdicts, a foreign or transferred owner, a foreign terminal
handle or run, `retained`/`released`/`release_pending` terminal state, and a missing row; false with
no fleet read at all for a settled, retained, reassigned, reincarnated, non-exact or disconnected
`worker-show`; and false with no observation at all for a receipt that is not the journaled one. It
also asserts the whole sequence issues no `worker-start` beyond the original launch, no
stop/retain/release/abandon/send, and no raw `terminal close`, and that admission occupancy is
untouched. The test fails against the previous PTY-only implementation.

### 3 — declared read-only scope vs. write claim

Reproduction showed the review's *alias* trigger is already closed: `agent-tools.ts` resolves the
typed selector through `enabled()` and assigns `a.project = p.id` before the `nativeScope` is built,
so the scope already carried the catalog id. That part of the finding is respectfully disputed. The
fail-open default behind it is real, so both halves are now closed:

- `agent-tools.ts` keeps the resolved `CommandProject` and builds `nativeScope.projectId` from
  `resolvedProject.id` explicitly, making the invariant local instead of depending on the earlier
  mutation.
- The `managed-runtime.ts` planner resolves the declared scope's selector through the catalog and
  fails closed: `native_scope_project_mismatch` when it does not resolve to a context project, and
  `native_scope_project_uncovered` when the context holds a project the scope does not cover. Neither
  case falls back to `write` any more.

Test: `resolves a declared scope through project aliases and fails closed instead of widening it to
write` — an `alias` selector plans as `projectId: "p"` with `access: "read"` and the declared
read-only resource intact, while an unmatched selector fails the request without launching and
without any write attempt.

### 4 — vacuous "no hidden conversation execution" proof

The unused `conversation` option is removed. `createManagedNativeRuntime` now owns the composition's
whole execute router and returns it as `execute`; `startManagedRuntime` calls `composition.execute`
instead of repeating the `/hq ` ternary inline, so the tested function is the production one. The
factory takes a `commands` port for `/hq ` and has no conversational parameter at all — a fallback
would have to be added to the tested router to exist.

Test: `routes every composed channel execute path through native admission with no conversational
fallback` drives ordinary channel text through `runtime.execute` and asserts it reaches native
admission while the `/hq ` command port is untouched, pins the composition surface to
`["execute", "native", "progress"]`, and separately asserts `/hq ` does route to the command port.

### 5 — `HQ_MAX_ACTIVE_WORKERS` typo

`parseMaxActiveWorkers` (exported from `managed-runtime.ts`) parses the variable at its boundary:
unset/blank → 10, `"unlimited"`, or a positive whole number; anything else throws
`HQ_MAX_ACTIVE_WORKERS="<value>" is not usable: set a positive whole number (for example 10) or
"unlimited".` The admission constructor's own validator is unchanged and still the last line of
defence. Test: `names HQ_MAX_ACTIVE_WORKERS and its accepted values when the env var is unusable`.

### Remaining limitations

- `observeNativeWorker` is now covered by a dedicated `orca-relay.test.ts` fixture test in addition
  to the coordinator contract test. Its fixture rows are modelled on read-only inspection of the
  installed CLI's real `worker-show` and `worker-list --run ... --json` output; no live agent was
  driven through an exit to produce a real `exited` verdict.
- `observeNativeWorker` does not inspect `projection.liveness.source`, only its `verdict`, since the
  guide enumerates verdicts (`live`/`unverifiable`/`exited`) but not sources. A host that reported
  `live` from a weaker source than `agent_status` would still reactivate.
- A rejected message is attributed best-effort from its envelope; a payload whose `taskId`/
  `dispatchId` are themselves malformed is quarantined with no `worker.recovery_required` event, and
  is visible only through `quarantined()`. There is no operator-facing surface for quarantine records
  yet (Task 5 configuration/UX scope).
- `native_scope_project_uncovered` makes a multi-project context with a single-project scope fail
  rather than partially plan. That is the fail-closed choice the review asked for; a per-project
  scope list would be the follow-up if multi-project scoped requests become real.
- No installation, restart, commit, push, new worktree, nested agent, or product-worker launch was
  performed. Task 5–7 scope was not touched.
