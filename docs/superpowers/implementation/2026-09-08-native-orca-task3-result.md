# Native Orca agents — Task 3 result

## Outcome and scope

Task 3 adds an admitted-work-only native launch path to the existing relay. It constructs an explicit public Orca worker launch for the exact existing checkout, observes the resulting Dispatch and terminal before producing a receipt, journals mutation intent and observed identity durably, supports narrowly proven same-session retained-terminal reuse, and leaves uncertain outcomes occupied without duplicate launch or model fallback.

This increment does not connect the native coordinator/runtime or channel entry points; that remains Task 4. It also performed no installation, build, service restart, commit, push, new worktree, subworker, external message, or live product launch. The legacy execution path remains available and its completion cleanup is preserved through an explicit adapter.

The original allowlisted contents were copied before edits to:

`/tmp/orca-hq-task3-originals.mMGvxI`

The protected roadmap was never read, hashed, diffed, staged, restored, or edited. Coordinator owns the implementation-plan checkboxes.

## Native launch API

```ts
const result = await relay.startNativeWork(item);
```

`startNativeWork(item: NativeWorkItem)` accepts only the exact Task 2 attempt currently admitted for launch (or a durable launch record eligible for recovery). A new attempt revalidates its project, exact worktree observation, primary-checkout resource claim, protected paths, requested terminal reuse, and the admission fence before either mutation. Concurrent calls for the identical attempt share one in-flight promise; a changed item with the same `attemptId` fails with `native_launch_collision`.

The result is one of:

- `{ state: "ready", receipt }`, only after `worker-show` proves the exact Task, Run, Dispatch, terminal, worktree, ownership, input-accepted stage, requested profile, and effective profile.
- `{ state: "proven_no_launch", proof }`, only after a typed authoritative pre-launch failure meets the whitelist below.
- `{ state: "recovery_required", ...identity }`, when task or worker effects may exist but cannot yet be proven. This state does not start a replacement or choose another model.

`buildWorkerStartArgs(item, { runId, taskId })` is the shared argument constructor. Fresh launch includes the exact `id:<worktreeId>` selector and explicit `--agent`, `--model`, and optional `--effort`. Reuse includes the exact worktree and `--terminal`, and deliberately omits all three profile launch flags because the public CLI rejects model/effort with terminal reuse.

`getNativeLaunch(attemptId)` exposes a cloned read-only journal entry for coordinator recovery. The journal contains the entire admitted item plus attempt, Run, Task, Dispatch, terminal handle/incarnation, exact worktree, requested/effective profile, retention policy, typed no-launch proof, warning/residual resources, two pre-effect intent IDs, and the actual Orca mutation request IDs when returned.

## Effect fencing and durable recovery

Task and worker intent phases are persisted before their external calls. The admission epoch/lease/generation/state assertion is repeated synchronously after asynchronous coordinator resolution and immediately before each mutation transport call. Relay shutdown sets its closing fence first, drains already accepted calls, persists their final ready or recovery journal state, and prevents the next mutation from beginning.

Only `result.mutation.requestId`, or `error.data.orchestrationRequestId` on an error receipt, is accepted as the Orca mutation identity. The outer RPC envelope `id` is intentionally ignored. Initial mutations never include `--retry-request`; a recovery call uses it only with that exact recorded mutation ID and only after `request-show` reports `completed` or `pending`. A lost reply without that identity stays `recovery_required`; `absent`, transport failure, and unknown status never create a fresh mutation. A late exact ready Dispatch may be adopted without a second worker launch.

`AuthoritativeNoLaunchProof` and `WorkerAdmission.recoverProvenNoLaunch(proof)` provide the bounded receipt-free recovery transition requested after Task 2. The current installed/runtime-supported whitelist accepts only a fresh-terminal worker result with all of the following:

- `state: "failed"` and `failedStage: "terminal_create"`;
- exact attempt, launch mutation, Run, Task, worktree, and requested-profile identity;
- no Dispatch/terminal identity that contradicts pre-launch failure;
- zero residual resources;
- effects limited to reuse of the already-admitted existing worktree and setup `not_applicable`/`skipped` observations.

Admission persists the proof and settles/releases the receipt-free claim transactionally without inventing a receipt or Dispatch. Unsupported failure stages, terminal/setup effects outside the whitelist, missing fields, mismatched identities, residual resources, and failed cleanup remain occupied and require reconciliation.

## Retained-terminal reuse

Reuse requires evidence from a prior settled Task 2 attempt in the same context and worktree whose verdict is `retained_idle`, whose receipt matches a prior Task 3 ready journal, and whose terminal handle and incarnation are unchanged. The relay then checks the exact prior worker, HQ-owned retained resource, connected/writable terminal, and a successful public `terminal wait --for tui-idle` result. The requested and effective agent/model/effort are taken from the attested prior receipt, not inferred from a possibly absent reuse launch payload.

Mismatched context, worktree, ownership, terminal incarnation, connection, idle state, or profile rejects reuse. A changed model requires a fresh terminal and explicit context handoff.

## Observation and legacy policy

`relay.get(id)` is observation-only and never releases a terminal. `relay.applyLegacyCompletionPolicy(id)` is the explicit compatibility adapter used by the existing legacy startup/polling flow. It preserves the prior exact-owned-terminal cleanup behavior without treating new native launch journal entries as legacy executions or duplicating cleanup. Current Task 3 native retention/release decisions remain the responsibility of Task 4 coordinator policy.

For legacy new-worktree launches, setup follows the current public CLI contract: `skip` only when explicitly selected, otherwise `run`. Exact existing-worktree launches never receive setup or creation flags.

## Public CLI and connection contract

Live read-only help was checked against installed Orca CLI `1.4.197` on 2026-09-08:

- `worker-start` accepts an explicit `--worktree` and exactly one of `--agent` or `--terminal`; HQ always supplies the exact worktree; `--model`/`--effort` apply only to a new agent, and existing worktrees never rerun setup.
- `request-show completed|pending` may be recovered with the original `--retry-request`; `absent` is explicitly not proof that no effect occurred.
- `worker-release` closes only an exact settled coordinator-owned new agent terminal and never blindly closes reused, pre-existing, user-owned, or unproven terminals.
- `terminal wait --for tui-idle` is the public idle observation used before reuse.

Discovery (`repo list`/`repo add`), relay launch, and recovery now share `selectOrcaCliExecutable()` and `selectOrcaCliEnvironment()`. Selection honors `ORCA_CLI_COMMAND`, the development launcher, the Linux `orca-ide` launcher, and a curated set of Orca connection/environment keys rather than forwarding the whole gateway environment. Tests inject isolated transports and environments; no unrelated executable or production Orca mutation was launched.

## Verification

TDD evidence:

1. Fresh/reuse command, profile/placement mismatch, partial/lost/late launch, typed no-launch, cleanup, observation-only, and CLI-selection cases were introduced against the pre-Task 3 relay surface and failed before implementation.
2. A coordinator-review regression reproduced an admission fence acquired during asynchronous coordinator resolution; before the final fix the relay correctly sent no worker mutation but misclassified the local pre-send rejection as `recovery_required`.
3. The relay now distinguishes a rejected pre-send boundary from an attempted transport, so that regression rejects with `coordinator_fenced` and performs zero `worker-start` calls.
4. Close-drain tests use file-backed isolated SQLite databases and prove both that an accepted task is journaled without starting a subsequent worker after close begins and that an accepted in-flight worker reaches a durable ready receipt before the database closes.

Final fresh focused checks:

```sh
pnpm exec vitest run apps/gateway/test/native-launch.test.ts apps/gateway/test/orca-relay.test.ts apps/gateway/test/worker-admission.test.ts apps/gateway/test/managed-commands.test.ts apps/gateway/test/managed-projects.test.ts
```

**5 files passed, 108 tests passed.** These use isolated transports and databases; they do not launch production workers.

```sh
pnpm exec tsc -p tsconfig.json --noEmit --pretty false
```

Passed using the root source aliases. No full suite or build was run.

## Modified paths

- `apps/gateway/src/native-launch.ts` (new)
- `apps/gateway/test/native-launch.test.ts` (new)
- `apps/gateway/src/orca-relay.ts`
- `apps/gateway/test/orca-relay.test.ts`
- `apps/gateway/src/worker-admission.ts` (minimal Task 2 API extension/formatting in the shared uncommitted file)
- `apps/gateway/test/worker-admission.test.ts` (typed no-launch transition coverage in the shared uncommitted file)
- `apps/gateway/src/managed-projects.ts`
- `apps/gateway/test/managed-projects.test.ts`
- `docs/superpowers/implementation/2026-09-08-native-orca-task3-result.md` (new)

`apps/gateway/src/managed-commands.ts` and its test were exercised but not changed by this Task 3 worker; their pre-existing shared Task 1/2 edits were preserved.

## Remaining integration boundary

Task 4 must instantiate and drive this API from the native coordinator, reconcile persisted attempts before reopening admission, apply the selected retain/release policy, and wire every runtime/channel entry through the shared gate. Until then, Task 3 provides the launch and recovery contract but does not claim installed native-first behavior, end-to-end channel delivery, or production acceptance.

## Coordinator closeout

Actual Orca provenance: Run `run_be0686a75462`, Task `task_b235127dd9c6`, Dispatch `ctx_1e66cc2246c8`, Codex `gpt-5.6-sol` / `high`, terminal `term_f7aae8a0-fd0e-415a-962e-4940718c0823` in the existing HQ checkout. The coordinator reviewed the native implementation and allowlisted original-file comparisons, checked actual read-only CLI worktree/worker/idle response shapes, and verified attested final test output: 108/108 tests, source typecheck exit 0, whitespace check exit 0 (22:17 KST). No outstanding Task 3 review findings remain.

Orca accepted succeeded `worker_done`; `worker-release` returned `released`, `closed_agent_terminal`, and transcript `captured`. Completion Delivery `delivery_f02ec0566efe` was acknowledged after release. Task 3 checkboxes are complete; Task 4 onward remain pending.
