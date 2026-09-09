# HQ Native Orca Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for task execution, with the Orca orchestration skill for all delegated workers. Do not substitute generic subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HQ dispatch substantive work into actual Orca project agent terminals, with configurable concurrent HQ-managed work admission across contexts and channels, initially set to 10.

**Architecture:** Keep durable HQ intake, context routing, resource reservations and the native relay. Replace optional conversation-driven execution with validated native work plans, a shared durable admission gate, and a Run delivery loop. Separate context identity, active Dispatch capacity and retained terminal lifecycle.

**Tech Stack:** Node 22.20–22.x, TypeScript, SQLite through `@orca-hq/persistence`, Zod, Vitest, pnpm 9.15.5, public Orca CLI (planning inspection: 1.4.197).

## Global Constraints

- Design: `docs/superpowers/specs/2026-09-08-hq-native-orca-agents-design.md`.
- Execution update: user authorized incremental implementation after the read-only audit. Implement one task at a time with one Orca worker and focused coordinator review. Tasks 1 through 3 are complete; Task 4 is next; no deployment, service restart, commits, pushes, Slack or Telegram messages in this increment. Earlier planning-only statements below describe the original planning turn.
- Preserve shared/uncommitted work. Never read/hash/diff/stage/restore/edit `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`.
- Default `maxActiveWorkers = 10`; applies to active/launching/uncertain HQ-managed attempts across channels, including fanout. HQ coordinator and settled retained terminals are excluded. This is not a limit on all OS agent processes.
- Configuration type is `number | "unlimited"`, defaults to 10 when omitted, and accepts positive safe integers or the explicit string `"unlimited"`. Reject 0, negatives, fractions, NaN, Infinity, unsafe integers and null. Apply at gateway startup; lowering the limit never kills existing work and pauses new admissions until occupancy is below the new limit. Unlimited removes only capacity waits, preserving reservations, ownership, dedupe and provider backoff.
- New work uses an actual agent terminal in the exact existing project checkout; no automatic worktree merely for parallelism.
- All substantive execution uses Orca Task/Dispatch. No hidden local-model execution fallback.
- The initial retained-primary-terminal policy is a design proposal pending user preference. Implementation must use the selected policy explicitly; tests cover both retain and release.
- All worker launches pass the same admission gate. Worker prompts request fanout through HQ and prohibit independent nested launch. Do not claim public Orca CLI provides a hard OS-wide spawn limiter.
- Preserve request idempotency, full-resource atomic reservations, generation fences, exact launch ownership, redaction, protected-path enforcement and existing channel authorization.
- Existing active work drains under its original engine. Migration never replays work or kills an existing terminal.

## Ownership and sequence

| Task | Owner/model recommendation | Deliverable | Dependency |
|---|---|---|---|
| 1 | Codex GPT-5.6 Sol high (selected for this increment) | Native plan and receipt contracts | None |
| 2 | Codex GPT-6 Astra high | Durable configurable worker admission (default 10) | 1 |
| 3 | Codex GPT-5.6 Sol high | Relay launch/model/terminal contracts | 1 |
| 4 | Codex GPT-6 Astra high | Coordinator loop and native-first runtime | 2, 3 |
| 5 | Codex GPT-5.6 Sol high | HQ terminal UX and configuration | 1; integrate after 4 |
| 6 | Codex GPT-5.6 Sol high | Migration, recovery and regression evidence | 4, 5 |
| 7 | Independent reviewer; Claude Opus high if available, otherwise Codex | Native acceptance and installation readiness | 6 |

The user selected sequential, cost-conscious execution: one task and one worker at a time, without repeated broad exploration or duplicate full reviews. Task dependencies still apply, but Tasks 2/3/5 will not be preemptively parallelized. Shared `managed-runtime.ts` integration belongs only to Task 4. This plan does not create 10 workers just to fill capacity.

## Task 1: Define native execution contracts

**Files:**
- Create: `packages/core/src/native-work.ts`, `packages/core/test/native-work.test.ts`.
- Modify: `packages/core/src/index.ts`, `packages/core/src/progress.ts`.
- Create: `apps/gateway/src/native-work-planner.ts`, `apps/gateway/test/native-work-planner.test.ts`.
- Modify: `apps/gateway/src/context-router.ts`, `apps/gateway/test/context-router.test.ts`.
- Modify as required for event-input validation: `apps/gateway/src/progress-store.ts`, `apps/gateway/test/progress-store.test.ts`, `packages/core/test/progress.test.ts`.

**Interfaces:** Export Zod schemas and inferred types with these shapes:

```ts
type LaunchProfile = {
  agent: "codex" | "claude";
  model: string;
  effort?: string;
  reason: string;
};
type NativeWorkItem = {
  attemptId: string; requestId: string; contextId: string;
  generation: number; projectId: string; worktreeId: string;
  objective: string; access: "read" | "write";
  resources: Array<{ resourceKey: string; mode: "read" | "write" }>;
  dependsOn: string[]; profile: LaunchProfile;
  resumeTerminalHandle?: string;
};
type NativeWorkerReceipt = {
  attemptId: string; runId: string; taskId: string; dispatchId: string;
  terminalHandle: string; worktreeId: string;
  requested: LaunchProfile;
  effective: { agent: string; model?: string; effort?: string };
};
```

`attemptId` is HQ identity assigned durably before effects; `dispatchId` is Orca identity observed afterward. Native-work planner consumes validated context/project inputs and returns items; dependency IDs reference items in the plan. The trusted executor revalidates placement, resource scope and profile allowlist; model output does not grant authority.

Task 1 integration boundary: the planner validates executable work and the router preserves mutually exclusive work/inline outcomes. Native-only runtime enforcement belongs to Task 4; do not introduce keyword matching as an execution guarantee. Trusted project scope names its primary checkout separately from other allowed resources so the primary claim cannot be omitted and secondary checkout declarations remain supported. Native event input and stored-event schemas must both validate native identity; adapt the store's pre-insert parser instead of attaching an unrefined `omit` method to a refined schema.

- [x] Add schema tests, including empty resources, unknown dependency, cycle, invalid profile and mixed reply/work bypass rejection. For the unit test create a complete literal item matching the shape above; use this assertion:

```ts
expect(() => NativeWorkItemSchema.parse({ ...item, resources: [] })).toThrow();
expect(NativeWorkItemSchema.parse(item).profile.model).toBe("gpt-5.6-sol");
```

- [x] Run `pnpm exec vitest run packages/core/test/native-work.test.ts apps/gateway/test/native-work-planner.test.ts apps/gateway/test/context-router.test.ts`; verify the new native contracts fail before implementation.
- [x] Implement schemas, allowlist-driven profile selection and plan validation. Preserve global jobs lookup and status/stop controls. Classify code analysis and review as work in router instructions even when read-only; enforce native execution binding in Task 4.
- [x] Add event kinds `worker.launching`, `worker.ready`, `worker.retained`, `worker.recovery_required` and truthful payload identity; leave legacy event parsing backward compatible.
- [x] Rerun the focused command and record contract review before dependent workers start.

Completed in the first implementation increment: focused tests 48/48; core, root source-alias and selected core-test no-emit checks passed. Standalone gateway typecheck requires the normal core declaration rebuild before use. See `../implementation/2026-09-08-native-orca-task1-result.md`. Runtime wiring and installed behavior are unchanged.

## Task 2: Persist global worker admission and atomic resource claims

**Files:**
- Create: `apps/gateway/src/worker-admission.ts`, `apps/gateway/test/worker-admission.test.ts`.
- Modify: `apps/gateway/src/progress-store.ts`, `apps/gateway/test/progress-store.test.ts`.
- Modify: `apps/gateway/src/context-executor.ts`, `apps/gateway/test/context-executor.test.ts`.
- Modify: `apps/gateway/src/execution-reservations.ts`, `apps/gateway/src/execution-compatibility.ts` and their tests.

**Interfaces:** `createWorkerAdmission({ store, maxActiveWorkers: 10 })` returns `enqueue(item)`, `claimNext()`, `bindReceipt(receipt)`, `settle(attemptId, dispatchId, outcome, resourceVerdict)`, `markUnknown(attemptId)` and `snapshot()`. `claimNext()` returns a NativeWorkItem or undefined. `snapshot()` returns `{active: number, queued: number}`. `outcome` is `succeeded | failed | stopped`; `resourceVerdict` is `released | retained_idle | transferred | unknown`. Only a proven released or explicitly retained-idle resource returns capacity; transfer preserves one occupied attempt and unknown retains it. SQLite stores attempts, FIFO sequence, resources, native receipt references and coordinator epochs. Admission methods are the only public writes to these tables.

- [x] Add the capacity test using one persistent store fixture, 11 unique read-only items and matching receipt fixtures:

```ts
for (const item of items) admission.enqueue(item);
const claimed = Array.from({ length: 10 }, () => admission.claimNext());
expect(claimed.every(Boolean)).toBe(true);
expect(admission.claimNext()).toBeUndefined();
expect(admission.snapshot()).toEqual({ active: 10, queued: 1 });
admission.bindReceipt(receipts[0]);
admission.settle(items[0].attemptId, receipts[0].dispatchId, "succeeded", "released");
expect(admission.claimNext()?.attemptId).toBe(items[10].attemptId);
```

- [x] Add cases for concurrent callers using two DB connections, duplicate attempts, restart with launching/unknown state, stale Dispatch settlement, mixed channel submit/retry, two workers within one context, blocked-writer/readers and secondary external resources. `settle` of a stale Dispatch must leave the snapshot unchanged.
- [x] Run `pnpm exec vitest run apps/gateway/test/worker-admission.test.ts apps/gateway/test/context-executor.test.ts apps/gateway/test/execution-reservations.test.ts apps/gateway/test/execution-compatibility.test.ts` and confirm new cases fail.
- [x] Implement one SQLite transaction for capacity + all resources + FIFO claim. Remove five-context capacity and one-native-worker-per-context constraint; retain sequencing of context planning turns. Move write ownership to attempt IDs so sibling worker reservations are distinguishable.
- [x] Parameterize admission tests with limit 12: claim 12 unique read-only attempts and queue the 13th. With `"unlimited"`, claim all 13 while still blocking a conflicting write. Reopen a store containing 12 active attempts with limit 10: preserve all 12 and admit nothing until occupancy drops below 10. Keep the default 10+1 test above as the initial operating configuration regression.
- [x] Keep unknown attempts reserved without TTL release. Reconcile persisted native ownership before opening admissions after restart. Run the focused tests until passing.
- [x] Add a coordinator owner epoch acquired transactionally at startup. Reject all mutations from a superseded epoch, including after its lease expires and another instance has acquired ownership. Test two gateway schedulers and release_pending/release_unknown versus retained_idle counting.

Completed in the second implementation increment: 62 focused tests across five files, root source-alias typecheck and allowlisted diff checks passed. Native planning is an explicit mode; the legacy default remains until Task 4 connects admission. Recovery/lease APIs and exact terminal claims are documented in `../implementation/2026-09-08-native-orca-task2-result.md`. Installed behavior is unchanged.

## Task 3: Make the relay launch explicit native profiles and terminals

**Files:**
- Modify: `apps/gateway/src/orca-relay.ts`, `apps/gateway/test/orca-relay.test.ts`.
- Create: `apps/gateway/src/native-launch.ts`, `apps/gateway/test/native-launch.test.ts`.
- Modify the relay-facing types in `apps/gateway/src/managed-commands.ts` and its tests only as needed for validated work input.

**Interfaces:** `startNativeWork(item: NativeWorkItem)` accepts only an admitted attempt, returns an observed receipt or durable recovery state. Extract public-CLI argument construction as `buildWorkerStartArgs(item, {runId, taskId})`. The relay journal stores `attemptId`, mutation request IDs, launch profile, exact Dispatch/terminal/worktree, and retention policy. No parallel alternate launcher in `packages/worker-routing` or `packages/orca-adapter` is introduced.

- [x] Test fresh command construction:

```ts
expect(buildWorkerStartArgs(item, { runId: "run_x", taskId: "task_x" }))
  .toEqual(expect.arrayContaining([
    "worker-start", "--worktree", `id:${item.worktreeId}`,
    "--agent", "codex", "--model", "gpt-5.6-sol", "--effort", "high"
  ]));
```

- [x] Add terminal reuse test: exact `--terminal` and `--worktree`; no `--agent`, `--model`, or `--effort` on reuse. Mismatched project, ownership, session or nonidle terminal rejects reuse. Changing model requires fresh terminal and explicit context handoff.
- [x] Add partial launch tests: task created/no worker yet, lost launch reply, late ready, failed startup with residual resources, unsupported model and failed cleanup. Assert no fresh mutation or model fallback while original launch may be live. Include a typed authoritative no-launch proof and admission recovery transition for a claimed attempt proven never launched; never fabricate a Dispatch or receipt to release its slot. Task 2 conservatively keeps receipt-free unknown attempts occupied.
- [x] Run `pnpm exec vitest run apps/gateway/test/native-launch.test.ts apps/gateway/test/orca-relay.test.ts`; implement the minimal launch/profile journal changes and rerun.
- [x] Refactor `get()` so observation never implicitly releases a terminal before coordinator retention/reuse policy executes. Preserve existing legacy completion behavior through an explicit policy adapter, not duplicate cleanup.
- [x] Preserve protected project/path guards. New-worktree launch, only when justified, uses current public CLI setup policy and exact repo selector; existing worktree launches do not rerun setup.
- [x] Reuse the existing CLI executable/connection selection contract for discovery, launch and recovery; remove the relay-only hardcoded binary mismatch. Add ORCA_CLI_COMMAND/dev/Linux selection fixtures without launching unrelated binaries.

Completed in the third implementation increment: 108 focused tests across five files, root source-alias typecheck and allowlisted whitespace checks passed. Launch mutation IDs are observed from Orca responses; initial calls never invent retry IDs. Exact admission fences, retained-session/idle checks, no-launch evidence and shutdown draining were reviewed. See `../implementation/2026-09-08-native-orca-task3-result.md`. Task 4 owns runtime/channel wiring and retention policy execution; installed behavior remains unchanged.

## Task 4: Connect native-first runtime and durable Run delivery loop

**Files:**
- Create: `apps/gateway/src/native-coordinator.ts`, `apps/gateway/test/native-coordinator.test.ts`.
- Modify: `apps/gateway/src/managed-runtime.ts`, `apps/gateway/src/progress-runtime.ts`, `apps/gateway/src/relay-coordinator.ts` and corresponding tests.
- Modify: `apps/gateway/src/managed-commands.ts`, `apps/gateway/src/agent-tools.ts` only where execution entry points must share admission.
- Modify: `apps/gateway/src/entry.ts`, `apps/gateway/test/entry.test.ts` to fence the alternate external-adapter execution composition until it can share admission; status/read-only functions stay available. Do not leave a second unbounded launcher enabled.

**Interfaces:** `createNativeCoordinator({ planner, admission, relay, store })` returns `execute(input)`, `start()`, `close()` and `processDelivery(delivery)`. `execute` conforms to the current progress runtime callback and completes only after required worker tasks settle. `processDelivery` persists message identities and per-message settlement before acknowledging the native Delivery. Persistent phases include received, applied, cleanup_pending and acknowledged.

- [ ] Replace the `conversation.execute` dependency in a managed-runtime fixture with a throwing spy; submit substantive analysis and assert native Task/Dispatch launch, zero hidden conversation execution, and no completed request before worker result.
- [ ] Test `worker.ready` absent before a ready launch receipt and present only with matching native identity. Keep acceptance and launching visible during delayed startup.
- [ ] Test one delivery containing success, question and stale completion. Required result: valid task settles once, pending question persists across reconnect, stale completion has no effect, cleanup policy executes before ack.
- [ ] Test duplicate delivery and crash after result persistence but before retain/release or ack. Replayed cleanup is idempotent. Uncertain cleanup records exact recovery and never falls back to raw terminal close.
- [ ] Test same-context active guidance is durable inbox mail, completed-context followup creates a new Dispatch, and changed scope queues a new item. Never call `terminal send` into a busy or user-owned terminal.
- [ ] Test fanout planning uses HQ admission: planner worker settles before waiting for children; child references form a validated DAG, children plus unrelated work cannot exceed the configured finite limit (10 by default); unlimited mode still enforces ownership and resource exclusion.
- [ ] Run `pnpm exec vitest run apps/gateway/test/native-coordinator.test.ts apps/gateway/test/managed-runtime.test.ts apps/gateway/test/progress-runtime.test.ts apps/gateway/test/relay-coordinator.test.ts apps/gateway/test/managed-commands.test.ts`; implement callback wiring and delivery journal, rerun.
- [ ] Ensure legacy submit/followup/retry and all channel entries use shared admission; preserve permission checks and user/project identity across adapters. Context routing must not silently force all sources to terminal/local.
- [ ] With `GATEWAY_EXTERNAL_ADAPTERS` selected, test that the alternate execution service cannot launch a root/verifier/fix/retry outside the admission boundary. Initial migration returns `native_admission_required` for unsupported execution composition rather than launching or silently changing providers; document this explicit compatibility limitation.

## Task 5: Display actual Orca execution in HQ

**Files:**
- Modify: `packages/installer/src/chat.ts`, `packages/installer/src/cli.ts`, `packages/installer/src/progress-client.ts`, `packages/installer/src/progress-window.ts` and corresponding tests.
- Modify: `apps/gateway/src/config.ts`, `packages/installer/src/config-files.ts` and their existing test owners.
- Modify: `README.md`.
- Modify: `packages/installer/src/watch.ts`, `apps/gateway/src/dashboard.ts`, `apps/web/src/routes/command-list.tsx`, `apps/web/src/routes/command-detail.tsx` only for shared native-state projection and labels; no unrelated UI redesign.

**Interfaces:** Configuration adds `maxActiveWorkers` default 10, role launch profiles and completed-primary terminal policy. Chat consumes native events from Task 1 and displays requested/effective model plus worktree/terminal/task identity. Native execution is server-owned and independent of viewer flags.

- [ ] Add tests that unspecified watch preference opens no macOS Terminal window, explicit old `--progress-window=auto` remains an optional watch viewer, and `--progress-window=off` never disables native launch.
- [ ] Add a receipt-backed display assertion using the existing chat fixture: output includes the exact returned worker handle and effective model; delayed launch displays waiting rather than running. Missing handle displays a verification state, not an invented reference.
- [ ] Add PTY regression for partial Korean input during acceptance, queue transition and final response. Job-list/help query still works without spawning a worker; a project-analysis request must spawn.
- [ ] Run `pnpm exec vitest run packages/installer/test/chat.test.ts packages/installer/test/chat-pty.test.ts packages/installer/test/cli.test.ts packages/installer/test/progress-client.test.ts packages/installer/test/progress-window.test.ts`; implement and rerun.
- [ ] Document actual native terminal close versus chat/watch close, configured active-worker capacity (default 10) versus retained idle terminals, mixed-provider failures and how to find the Orca terminal. No automatic desktop focus stealing is required.
- [ ] Preserve source-tagged output, observedAt separately from native updatedAt, and unknown/release states in dashboard/watch projections. Add focused rendering assertions in the existing dashboard and installer tests; a transcript tail or worker success report must not become an asserted test pass.

## Task 6: Migrate and prove recovery without replay

**Files:**
- Modify: `apps/gateway/src/progress-store.ts`, `apps/gateway/src/managed-service.ts` and their tests.
- Modify: `tests/e2e/context-progress.spec.ts`.
- Create: `tests/e2e/native-orca-progress.spec.ts`.
- Create: `docs/superpowers/implementation/2026-09-08-native-orca-migration.md`.

**Interfaces:** Additive schema version and `executionBackend` discriminator per assignment (`legacy_conversation | native_orca`). Native context linkage never treats a legacy provider thread ID as a native terminal/session. Startup has a recovery barrier before admission.

- [ ] Seed the real SQLite fixture with old completed, active, uncertain and queued assignments; reopen under migration. Assert completed/active/uncertain jobs create zero replacement workers and queued untouched requests use the selected new backend exactly once.
- [ ] Add real-socket tests for two contexts, same-context followup, mixed-channel shared capacity, 10+1, failure result, stop, unknown launch, retained terminal reacquisition and gateway restart. Fixture Orca transport must be isolated from installed production state.
- [ ] Run `pnpm exec vitest run tests/e2e/native-orca-progress.spec.ts tests/e2e/context-progress.spec.ts apps/gateway/test/progress-store.test.ts apps/gateway/test/restart-fixture.test.ts apps/gateway/test/managed-service.test.ts` and implement migration/recovery fixes.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm -r build` once integration is stable. Record fresh counts and commands; do not recycle the earlier 1076-test result.
- [ ] Write exact changed-file allowlist and installation/rollback sequence: backup source/build/config/DB; preserve current active work; install matched build artifacts; restart normally; reconcile; check health and new request. A rollback stops new admissions, preserves current DB and native attempts, and never restores an old DB snapshot while newer workers may be live. If old binary cannot read migrated state, roll forward or provide a compatibility reader; no destructive downgrade.

## Task 7: Native acceptance and independent review

**Files:**
- Create: `docs/superpowers/implementation/2026-09-08-native-orca-verification.md`.
- Update: migration report with acceptance evidence; production fixes go back to their responsible implementation task.

- [ ] Review native-path enforcement, profile injection, global admission, migration and retention against the spec. Use a fresh actual Orca Task/Dispatch reviewer. Confirm Claude availability before selecting it; use Codex if unavailable and disclose actual model.
- [ ] In a permitted disposable project, submit a bounded analysis through **the actual HQ endpoint**, not direct coordinator CLI. Confirm matching project, native Task/Dispatch, visible agent terminal receipt, provider output and returned HQ result.
- [ ] Submit two distinct work items, then a followup to one. Record independent terminals and correct same-context behavior. Use the selected retention policy; distinguish same process reuse from new terminal with context handoff.
- [ ] With the default limit set to 10, exercise 10 bounded native workers held on an explicit coordinator question/barrier, then submit an 11th. Persist 10 distinct Dispatches/terminals; verify no 11th launch, release one through a proper worker outcome and prove exactly one queued launch. Do not infer concurrency from sequential launch logs or mock tests.
- [ ] Restart the HQ gateway while a bounded worker is active, then verify preserved task/terminal identity and no duplicate. Close a viewer separately from stopping a disposable native worker; validate different behavior.
- [ ] Inspect Orca project UI through an allowed Orca surface when available, recording visible tabs/labels and agent output. CLI `surface: visible` is launch evidence, not screenshot evidence. Never bypass a Computer Use rejection with another UI automation tool. If GUI inspection is unavailable, record that acceptance gap explicitly rather than claim full visual verification.
- [ ] Release or transfer every temporary test/review worker using exact Dispatch ownership; retain only explicitly requested product terminals. Verify no abandoned test assignments or pending deliveries.
- [ ] Present installation readiness and any remaining evidence gaps. Implementation and installation occur only in the subsequent authorized execution scope; this planning turn ends with documents.

## Planning provenance

Orca Run: `run_298f0f13111b`.

| Review | Task | Dispatch | Model | Actual created terminal |
|---|---|---|---|---|
| Architecture | `task_77fdb599bae2` | `ctx_a42c7205a881` | Codex gpt-6-astra high | `term_fbd0e670-c3b8-4efc-89a8-a7e972dcf83b` |
| Acceptance | `task_a44f2365e786` | `ctx_542efde3f68b` | Codex gpt-5.6-sol high | `term_611f6a54-9455-4420-bcf6-e4f7e5460a70` |

Both worker-start receipts reported existing HQ checkout reused, visible agent terminal created and dispatch input accepted. This proves this plan's orchestration placement, not that HQ product migration is implemented.

Architecture review reconciliation: the five bounded findings in `../implementation/2026-09-08-native-orca-architecture-audit.md` are reflected in explicit configuration validation (the user subsequently selected default 10 with adjustable/unlimited capacity), Task 4 alternate-entry fence, Task 2 coordinator epoch, the explicit settle resource verdict, and Task 3/5 CLI/renderer ownership. The final design conservatively holds release-unknown capacity; confirmed retained-idle resources are excluded. This final policy supersedes alternative accounting recommendations in the historical audit.

Acceptance review reconciliation: `../implementation/2026-09-08-native-orca-acceptance-audit.md` supplies the failure matrix and a baseline run of 9 files / 73 existing tests. Tasks 2, 4, 6 and 7 cover global admission, mixed-channel fanout, exact lifecycle recovery and real native 10+1 evidence. The final spec takes precedence over the reviewer's release-default/new-worktree recommendations, as noted at the top of that audit. Both review Dispatches completed successfully and were released through Orca with transcripts captured. No production implementation or installation occurred during planning.

User decision update: 10 is the initial operating setting, not a fixed product maximum. The configuration contract above supersedes the historical audits' hard-cap recommendations; this documentation update does not change the installed runtime.
