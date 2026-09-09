# Native Orca architecture audit

Date: 2026-09-08. Scope: planning only; gateway routing, native execution, context continuity, worker admission, recovery, and UI truthfulness. No implementation or runtime launch was performed. The explicitly excluded private roadmap was not opened, hashed, diffed, or modified. Findings describe inspected source at audit time; other workers may be editing concurrently.

## Recommendation

Evolve the installed managed runtime through its existing Orca relay. Keep HQ as the project/agent/model decision maker and durable scheduler, with every substantive assignment executed by a supervised agent terminal in an observed Orca project workspace. Preserve contexts as conversation/history identities; use native Task/Dispatch identities for attempts and a separate durable, installation-wide admission ledger for the maximum of 10 active workers, including verification, retries, and fanout across all channels.

A shared HQ Run with context-to-Task DAG mapping is viable. Orca Run is a namespace and coordinator inbox, not a scheduler. HQ must own capacity, dependencies, resource conflicts, and delivery handling; merely creating a Run or increasing `maxContexts` cannot supply these guarantees.

Retaining completed primary terminals is a proposed option, not an established behavior. The coordinator reports that the user retention preference is pending. The coordinator's final draft explicitly defines the cap as **active HQ-managed attempts**, excluding settled retained terminals and HQ itself. This audit uses that definition below; retained live process count must be displayed separately so the product never implies that only 10 agent processes can exist.

## Evidence and present execution paths

| File / symbol | Present behavior | Architectural consequence |
| --- | --- | --- |
| `apps/gateway/src/entry.ts`, `runInstalledGateway` | Default installed entry uses `startManagedRuntime`; `GATEWAY_EXTERNAL_ADAPTERS` selects the separate production composition. | Audit and migration must cover both launch surfaces or explicitly disable the alternate launcher. |
| `apps/gateway/src/managed-runtime.ts`, `startManagedRuntime` | Composes catalog, relay, coordinator recovery, conversation agent, context router, progress runtime, reservations, channels. Creates two Codex session clients in `agent-workspace`. | This is the primary migration seam. HQ session processes are outside native Orca worker terminals. |
| `apps/gateway/src/codex-session.ts`, `createCodexSessionClient` | Spawns `codex app-server --stdio --strict-config`; disables shell/exec and other general tools, uses read-only sandbox and dynamic HQ tools; supports `thread/start` / `thread/resume`. | Existing HQ reasoning is constrained, but its thread is not a native worker session. Do not advertise an app-server turn as a launched Orca worker. |
| `apps/gateway/src/context-router.ts`, `Decision`, `routerInstructions` | Routes semantic new/continue contexts, questions, lookup/control; validates observed project/context IDs. Limits one decision to 10 parts. | Reuse context classification. `parts.max(10)` is an input limit, not a global worker budget. Agent/model/effort are absent. |
| `apps/gateway/src/agent-conversation.ts`, `agentInstructions`, `execute` | Persists HQ thread and tool/effect journals; may investigate through metadata/terminal tools and compose an answer without a native job. Instructs development/review to use Orca jobs. | Preserve conversational continuity and idempotency, but make the substantive-work requirement structural rather than relying on prompt compliance. |
| `apps/gateway/src/agent-tools.ts`, `actions`, `orca_execute` | `jobs.run` accepts project/prompt/worktree/resource access, but no agent/model/effort. Context execution requires an observed worktree and full resource declaration. | Add a typed execution decision and capability validation. Keep metadata discovery for routing; substantive repository investigation/review/planning must produce a native assignment. |
| `apps/gateway/src/managed-commands.ts`, `ManagedCommandPorts`, `execute` | Translates validated job actions to relay submit/followup/retry/stop. | Route all mutations through the common admission/lifecycle boundary. Do not leave direct commands as a bypass. |
| `apps/gateway/src/orca-relay.ts`, `create`, `background` (around lines 604–804) | Journals requests, creates native Task, then calls `worker-start`; hardcodes `--agent codex`. Without worktree selects new-top-level, with worktree creates a new agent there. | Native execution already exists. Extend launch selection and receipts instead of replacing it with raw provider subprocesses. |
| `apps/gateway/src/orca-relay.ts`, `followupWork` (around lines 806–868) | Running followup sends Run mail to stable `dispatch:<id>`; settled followup creates a new Task/worker in the same workspace with parent linkage. | Running guidance is mail, not proof of prompt consumption. Same workspace does not mean same agent session. |
| `apps/gateway/src/orca-relay.ts`, `get` (around lines 426–545) | Observes worker; auto-releases owned succeeded/failed workers unless retained/released; can fallback to bounded worker output as result text. | Separate observation from cleanup. Current read-side release can destroy the opportunity for immediate terminal reuse. A transcript tail is not validated completion evidence. |
| `apps/gateway/src/context-executor.ts`, `createContextExecutor` | Default `maxContexts=5`; occupied count is distinct turn/native context IDs. `retainNative` rejects a second different native job within one context; state is in memory. | Wrong accounting unit and no context fanout. Keep serial context turns, replace capacity ownership. Setting this number to 10 is insufficient. |
| `apps/gateway/src/progress-runtime.ts`, `beforeNative`, `onNative`, `notify`, `start` | Forbids a second nonterminal job per context; binds jobs/reservations to generation; restores unknown occupancy after restart; releases context capacity from terminal job state. | Generalize attempt ownership for fanout, preserve stale-generation fencing. Release active-attempt capacity only on authoritative settlement; track remaining live terminals separately. |
| `apps/gateway/src/progress-store.ts`, reservation and context/job tables | Durable requests, context agents, generations, events, viewer leases, resource reservations, job linkage. | Reuse history and reservation data; add separate dispatch/terminal admission rows, not a numeric field on contexts. |
| `apps/gateway/src/execution-reservations.ts`, `normalizeResourceAccesses`; `execution-compatibility.ts` | Normalizes checkout/external resources, maintains durable ownership, blocks conflicting legacy launches. | Keep conflict semantics independently of worker count. Compatibility currently supplies resource waits, not a shared global worker cap. |
| `apps/gateway/src/relay-coordinator.ts`, `resolve` | Persists handle/workspace/tab, accepts only explicit stale-handle evidence for replacement, requires complete terminal inventory, journals ambiguous creation, refuses another live coordinator, rebinds Run. | Useful recovery base. Terminal handle/title/tab are routing clues, not sufficient durable coordinator authority. |
| `packages/orca-adapter/src/{index,capabilities,receipts,process}.ts` | Typed commands, capability/version checks, receipts, process error handling. Dispatch operation supports codex/claude but lacks model/effort, terminal reuse, inbox delivery, request recovery. | Consolidate relay RPC here after extending the actual contract; do not force relay into an incomplete interface. |
| `packages/worker-routing/src/{execution-service,providers,lifecycle,completion-gate,verifier,worktree-placement}.ts` | Separate production DAG, Codex/Claude native providers, durable recovery, locks, verification and remediation. | Reuse proven lifecycle/receipt/verification concepts. Do not run two competing schedulers or wholesale-import the older proposal/placement architecture. |

The `CodexWorkerProvider` and `ClaudeWorkerProvider` are wrappers around OrcaWorkerProvider; they do not justify replacing native execution with direct `codex exec` or `claude` processes. The alternate production path already launches native workers but also needs the common admission boundary.

## Live public Orca contract checked

Read-only `orca status --json` reported runtime 1.4.197, ready/reachable, with `orchestration.contract.v1`, `orchestration.worker-stop-verdict.v1`, and `orchestration.worker-launch-preferences.v1`. The installed `orca-cli` and orchestration guides and command help were inspected; native Orca source was not audited.

- `worker-start --task ... --run ... --worktree id:<repo>::<path> --agent <provider> --model <id> --effort <level>` is supported. Model IDs are opaque provider IDs. Model flags support Claude, Codex, and Cursor; effort requires model. Do not infer that every provider accepts every effort.
- `worker-start --task ... --terminal <handle> --worktree <exact-selector>` supports supervised reuse. `--terminal` cannot combine with model/effort; a request to change those settings needs a new agent session and an explicit context handoff.
- Existing/current workspace launch does not rerun setup and creates a fresh agent unless terminal reuse is explicit. New-worktree launch is agent-first and honors repository startup sequencing. New-worktree flags are invalid for existing workspaces.
- `worker-start` exits successfully only for ready; failure/unknown receipts can contain partial effects and residual resources. Readiness proves launch readiness, not work completion.
- `worker-list` distinguishes process-resource state (`active`, `reclaimable`, `retained`, `release_pending`, `release_unknown`, `released`) from Task status. A completed Task can still own a live terminal.
- `worker-release` preserves inspectable output and closes only proven owned agent resources; retained, reused, user-owned, or unproven resources need correct handling. Never substitute blanket `terminal close` for pending/unknown release.
- `request-show --request` and replay with `--retry-request` preserve mutation identity. “Absent” is not proof that nothing happened. Current relay request phases do not yet persist and use this native request identity.
- Coordinator `check` returns durable FIFO Delivery; process all messages and acknowledge its delivery ID. Replay is expected until ack. `ask` remains pending after a timeout and must resume its original message ID.
- Default nested-worker depth is one; depth is not concurrency. The guide explicitly says it is a guardrail rather than a security boundary. No public global 10-worker admission primitive was found in the inspected surface.
- Low-level `dispatch --inject` creates context-only unsupervised dispatches; it does not provide the same terminal ownership as `worker-start`. Use composed supervised start for HQ-managed workers.

## Proposed boundaries and interfaces

Illustrative TypeScript below describes new interfaces, not existing exported APIs or confirmed new Orca flags.

```ts
type ExecutionTarget = {
  serverId: string;
  projectId: string;
  workspaceId: string;
  workspaceIdentity?: string; // only if returned/attested by Orca
  agent: string;
  model: string;
  effort?: string;
};
type WorkAssignment = {
  contextId: string;
  requestId: string;
  taskKey: string;
  parentTaskKey?: string;
  dependsOn: string[];
  target: ExecutionTarget;
  access: ResourceAccess[];
  instruction: string;
  continuation: { kind: 'fresh' | 'reuse' | 'handoff'; priorDispatchId?: string };
};
interface WorkerAdmission {
  reserve(input: { assignment: WorkAssignment; coordinatorEpoch: number }): Promise<
    { state: 'admitted'; admissionId: string } |
    { state: 'queued'; reason: 'capacity' | 'resources' | 'dependency' }
  >;
  bind(input: { admissionId: string; nativeRequestId: string; dispatchId: string }): Promise<void>;
  reconcile(observations: NativeWorkerObservation[]): Promise<void>;
}
interface NativeWorkerRuntime {
  capabilities(): Promise<LaunchCapabilities>;
  start(input: { assignment: WorkAssignment; admissionId: string; mutationKey: string }): Promise<LaunchReceipt>;
  reuse(input: { assignment: WorkAssignment; admissionId: string; priorDispatchId: string; mutationKey: string }): Promise<LaunchReceipt>;
  read(dispatchId: string, cursor?: string): Promise<SourceTaggedOutput>;
  inspect(dispatchId: string): Promise<NativeWorkerObservation>;
  recoverRequest(nativeRequestId: string): Promise<MutationObservation>;
  stop(dispatchId: string): Promise<StopReceipt>;
  release(dispatchId: string): Promise<ReleaseReceipt>;
  retain(dispatchId: string, preferenceId: string): Promise<RetentionReceipt>;
}
interface CoordinatorInbox {
  next(runId: string): Promise<Delivery>;
  reply(questionId: string, body: string, mutationKey: string): Promise<Receipt>;
  acknowledge(deliveryId: string): Promise<Receipt>;
}
```

HQ decides targets from observed catalog/workspaces, prior context, installed launch capabilities, and user instructions. Persist selected target and decision rationale before effects. A provider/model fallback is a changed decision; never silently execute with Codex defaults after a selection failure. Preserve the full original constraints in every assignment. Metadata listing and request classification can remain in the HQ control process; code inspection, research, review, planning, testing, document production, and edits are substantive and must be assignments. A general answer path must not silently perform those tasks in the app-server.

## Global worker admission and fanout

1. Establish a single admission authority across terminal, Slack, Telegram, web, legacy command paths, and alternate production composition. A durable owner lease plus monotonically increasing coordinator epoch fences stale schedulers. In-memory serialization only protects one process.
2. Serialize context intent/history updates independently. One context may own multiple sibling workers; many inactive contexts may exist without consuming capacity. A parent coordinating worker is counted while live, along with every child and verifier. A metadata-only HQ control process or a progress viewer is not a worker.
3. Reserve one slot per new active attempt before `worker-start`; launch-pending and outcome-unknown attempts count. Reuse a settled retained terminal only after acquiring a new attempt slot and resources. Keep an independent process ledger so overlapping cleanup/reuse does not double-count a physical terminal. A slot is not keyed by context, Task alone, or provider thread alone.
4. Use a transaction to check capacity and claim durable admission. Coordinate resource acquisition so tasks do not monopolize scarce slots while waiting for locks; for example, reserve capacity and all declared resources together in the same store transaction. Queue unavailable work without launching. Keep read/read sharing and read/write exclusion.
5. Fanout becomes a structured worker request to HQ with parent dispatch, proposed children, dependencies, placement, and resources. HQ validates and admits each child through the same path. Workers do not call native worker-start or generic subagent spawning themselves. Keep native nested dispatch disabled where configurable and audit unexpected descendant workers; prompt instructions alone are not a hard capacity guarantee.
6. Parents requesting children should be asynchronous or yield their assigned terminal at an agreed handoff point; otherwise 10 waiting parents can deadlock the pool. Do not free a parent slot merely because it asked a question while its agent still runs. Fair queueing must prevent a single context from starving the rest.
7. Authoritative worker completion changes task outcome and can free active-attempt capacity under the selected definition. Retain/release must still be journaled and reconciled before delivery acknowledgment. An ambiguous launch/stop/settlement keeps its slot; disconnect, heartbeat expiry, or absence from partial inventory is not settlement. A release failure after independently proven settlement leaves a process-cleanup obligation but does not retroactively make the settled attempt active. Preserve this distinction explicitly in tests and UI.
8. On restart, reconcile every nonreleased admission and complete native inventory before draining queued starts. Persist partial launches that have no Dispatch ID. Never use `listCached()`'s recent-20 view or context count as the global count.

Guaranteed scope should be all **HQ-managed** workers across channels, projects, Runs, and fanout. Counting manually created Orca workers can inform a conservative “observed Orca total,” but HQ alone cannot prevent unrelated actors from launching concurrently. If the requirement means a hard ceiling for every agent anywhere in Orca, a native runtime admission hook is an upstream requirement; do not claim that a polling HQ ledger enforces it.

## Context continuity and retention

Store three separate things: HQ context/history identity, native Dispatch/terminal/session provenance, and project/workspace identity. Existing `progress_contexts.thread_id` and `conversations.sqlite` preserve HQ conversation history only. Neither proves native provider session reuse.

- Active assignment: send supplemental instructions to the stable Dispatch mailbox and record delivered versus consumed separately; scope changes become queued tasks. Worker question replies use `reply` to the question, not a generic status message.
- Settled primary with immediate followup: inspect the exact settled Dispatch, verify its terminal is available in the same workspace, and `worker-start` a fresh Task/Dispatch with that terminal. Transfer cleanup/admission ownership atomically in HQ's journal. Do this before any automatic release.
- Optional retained primary: if the user chooses retention, persist that preference and call native retain explicitly. Under the chosen active-attempt cap, settled retained primaries consume no execution slots but remain visible in separate process/resource accounting. Reuse reacquires capacity; do not silently evict user-retained terminals or claim a 10-process ceiling.
- Released, stale, model-changed, or unprovable session: preserve the logical context and provide a bounded handoff (objective, decisions, workspace, artifacts, validated results, pending questions) to a fresh native worker. Label this “context continued in a new worker.” Exact provider session restoration must use an attested supported Orca mechanism, never guessed transcript paths/session IDs.
- Same project is not sufficient for reuse. Require same intended workspace, compatible selected provider/model, no live owner, and no ambiguous process identity. Do not infer identity from terminal title alone.

## Coordinator lifecycle and recovery

Reuse the existing `relay-coordinator.json` placement and creation journal as migration input, but add durable coordinator ownership/epoch and Run binding. The current recovery creates a plain terminal without an agent command: this is a coordinator routing anchor, not proof of a reasoning HQ agent in Orca. If product intent also requires HQ itself to be a native agent terminal, that is an additional launch/composition change; do not relabel the existing shell as an agent.

Implement a Run Delivery consumer alongside state reconciliation. Durably record received delivery/message IDs, update attempt state, route questions, choose reuse/retain/release for completions, then ack. Replayed delivery must not duplicate child launches, replies, releases, or user notifications. An unavailable user answer remains a pending question, not a worker failure. Current relay has no `check`/ack/question consumer; polling task state alone leaves blocking worker asks unresolved.

Recovery order: acquire coordinator epoch; verify chosen CLI/runtime/server; load Run and pending native request identities; recover terminal identity using complete authoritative inventory; confirm stale prior authority before rebind; reconcile workers/resources/admissions; recover unacknowledged deliveries; only then admit queued tasks. Never replace a worker because the coordinator or desktop restarted. Do not use retired coordinator-start/run scheduler commands. Legacy takeover is a separate attested flow, not a generic way around another live coordinator.

`orca-relay.ts/runOrca` currently hardcodes `orca` and filters the child environment, whereas catalog/tool invokers respect `ORCA_CLI_COMMAND`, dev, and Linux selection. Consolidate executable and connection target selection so discovery, launch, and recovery cannot target different runtimes. Runtime-scoped terminal handles are cached routing metadata; correlate server/runtime, native request, Task/Dispatch, workspace, and attested terminal/session evidence.

## Truthful UI and event semantics

| Current evidence / surface | Required presentation |
| --- | --- |
| `progress-runtime.ts` emits `agent.started/resumed` before native launch for constant `hq-context-agent`; `packages/installer/src/watch.ts` labels these “작업자 시작/재개”. | Rename/version these as HQ routing/planning events. Emit native worker started only after an accepted ready receipt with actual placement. |
| `packages/installer/src/progress-window.ts` uses AppleScript to open macOS Terminal running `hq watch`. | This is a progress viewer. It is not an Orca agent terminal and never satisfies native worker placement or worker count. Keep only as an optional clearly named viewer; open actual worker through observed Orca terminal linkage. |
| Router context assigned or job Task created | “Request accepted / queued”; show capacity, dependency, or resource wait reason. No running claim yet. |
| Native ready / working / awaiting answer | Show separate lifecycle and interaction states, actual agent/model, project/workspace, and a link/control for the proven terminal when live. |
| HQ thread resumed versus exact agent reused | Show distinct events. A new native session with context handoff must not say the old agent resumed. |
| Worker completion / verification / process cleanup | Separate reported task outcome, validation evidence, and release state. Succeeded worker report is not automatic test pass. `release_unknown` remains visible in process accounting; an independently settled attempt no longer consumes execution capacity. |
| `nativeProgress()` calls `job.updatedAt` lastObservedAt; cached job reader labels stored observations | Store actual observed-at time separately from native updated-at time and expose freshness/incomplete scope. A historical update time is not the last successful observation time. |
| `apps/gateway/src/dashboard.ts`, `apps/web/src/routes/{command-list,command-detail}.tsx`, installer watch | Project common worker projections with selected versus observed model, attempt IDs, capacity `n/10`, retained/unknown counts, and source-tagged evidence. Do not present context rows as worker rows. |

## Reuse / replace / remove plan

- **Retain and extend:** managed catalog and project/workspace validation; context router semantics; request/effect dedupe; progress/event persistence; resource normalization and generations; relay native task/request journal; guarded coordinator recovery; channel transport and existing contextual history.
- **Replace:** `context-executor` capacity logic with worker admission, retaining per-context ordering separately; `beforeNative` single-worker restriction with assignment/DAG admission; hardcoded Codex launch with validated target selection; read-side auto-release with completion lifecycle decisions; naked task polling with durable Run delivery plus observation reconciliation.
- **Consolidate:** all RPC invocation/capability/receipt parsing into the adapter; all substantive launch paths into one admission/runtime interface. Integrate or fence the external production ExecutionService so its ready roots, fix tasks, and verifier tasks cannot bypass global capacity.
- **Remove from execution semantics:** macOS Terminal watcher as evidence of worker existence; HQ app-server `agent.started` as native-start evidence; implicit provider fallback; using a context count or recent job list as a worker budget. Keep optional viewers and history tools where accurately labeled.
- **Do not delete wholesale:** local L0 summary utilities (`local-codex.ts`, `local-service.ts`, `conversation-ai.ts`) and alternate production modules may have callers/tests. Fence their substantive execution first, then remove only proven unreachable code in a later scoped change. Preserve protection rules in relay `protect()`; live acceptance must use a permitted disposable repository.

## Migration risks and acceptance gates

| Risk | Required migration / validation |
| --- | --- |
| Split-brain HQ or simultaneous channels oversubscribe | Transactional 10-slot admission and coordinator epoch tests across two scheduler instances; 11th distinct worker queued even when all belong to one context. |
| Fanout or alternate executor bypasses budget | Verify root, child, verifier, fix, retry, and legacy/direct command launches all hit admission; reject unauthorized child starts before process creation. |
| Task completion confused with process exit | Test completed+retained and release_pending/unknown after authoritative settlement as process obligations, plus unproven stop/settlement that retains active capacity. Report unsupervised resources separately. |
| Followup races cleanup | Prove exactly one ownership transition: reuse or release, never both; immediate same-session followup gets a new Dispatch and no second agent terminal. |
| Database cutover loses live workers | Additive/versioned migration of relay requests, snapshots, context jobs, conversations and reservations; inventory adoption does not replay prompts. Old generations cannot launch after cutover. |
| Crash between capacity, task creation, start, receipt, bind, completion, ack | Fault-inject each boundary; reconcile native mutation identity and retained slots without duplicate launches or duplicate user results. |
| Worker asks hang forever | Durable FIFO delivery/reply/ack integration including replay, pending question across restart, late completion from old Dispatch, and heartbeat liveness. |
| Model/agent request silently ignored | Assert launch argv/receipt preserve selected settings; unsupported combinations produce explicit selection failure before spawn; reuse forbids silent model changes. |
| Stale coordinator handle/title reuses wrong process | Full inventory and original workspace evidence; duplicate title, partial host inventory, connection failure, stale handle, lost terminal-create response, and live competing coordinator fixtures. |
| Folder/project/host identities differ | Persist exact selected server/project/workspace; avoid repo prefix assumptions for folder/project-host setups. Existing relay currently requires repo-style `id::path` worktrees for execution. |
| Existing library policies conflict with managed path | Reuse receipt/verification code selectively. Production provider policy checks include environment isolation and different verifier family; do not weaken them accidentally or misrepresent them as supported by native launch. |
| UI promises exceed observations | Tests distinguish context routing from native ready, fresh handoff from resumed session, worker report from validation, and updated-at from observed-at. |
| Rollback starts old workers twice | Rollback may read new projections but must not resume an older unfenced launcher; drain/reconcile existing Dispatches before changing execution ownership. |

Start with focused extensions to `apps/gateway/test/{orca-relay,relay-coordinator,context-executor,progress-runtime,execution-reservations,execution-compatibility,agent-tools,agent-conversation,managed-runtime}.test.ts`, adapter capability/receipt fixtures, production execution-service admission tests, and installer watch/window tests. Follow with disposable-repo live acceptance proving visible native placement, chosen provider/model, one-context fanout under a shared 10 cap, exact followup reuse or honestly labeled handoff, coordinator restart, and failed-release accounting. This audit ran no implementation tests: its evidence is source inspection and read-only installed CLI contracts.

The coordinator's final draft resolves scope to HQ-managed active attempts, excluding HQ and settled retained terminals; independently launched non-HQ workers are outside its hard guarantee. Retained-primary preference remains pending. The final proposal uses a shared Run, centralized fanout admission, metadata-only HQ control reasoning, and no hidden execution fallback.

## Bounded comparison with coordinator drafts

Compared only `docs/superpowers/specs/2026-09-08-hq-native-orca-agents-design.md` and `docs/superpowers/plans/2026-09-08-hq-native-orca-agents.md`, as requested by the coordinator. The native-first direction, shared Run, atomic resource/admission claim, context fanout, exact terminal reuse, removal of get-triggered cleanup, no model fallback on unknown launch, existing-active drain, and honest watcher semantics agree with this audit. No implementation or changes to those drafts were made by this worker.

Remaining concrete gaps to tighten before implementation:

1. **Hard maximum versus configurable default:** the design/plan say default `maxActiveWorkers=10` and propose configuration, while the user asks for a maximum of 10. Validate any configurable value in `1..10`; otherwise an operator-configured 11 violates the requirement even if admission works correctly.
2. **Alternate production entry:** Task 4 names legacy and channel actions but does not explicitly name `entry.ts`, `production.ts`, or `packages/worker-routing/src/execution-service.ts` as integration/fencing ownership. `GATEWAY_EXTERNAL_ADAPTERS` can still select that separate native launcher. Either integrate its root/verifier/fix/retry admissions into the shared gate, or fail closed for new substantive execution in that mode while old attempts drain.
3. **Coordinator split-brain:** two-connection capacity tests cover transactional counting, but the plan should explicitly persist a scheduler owner epoch/lease (or prove the existing single-owner invariant) and fence old coordinator mutations. A stale scheduler can inject/reply/settle incorrectly while total count remains below 10. `relay-coordinator.ts` currently has only in-process serialization plus a placement JSON file.
4. **Release uncertainty after settlement:** make Task 2's `settle` contract and Task 4's `cleanup_pending` state agree with the chosen attempt cap. An authoritative completed-and-retained attempt is excluded; failed stop without proven settlement remains counted; failed release after proven settlement is a visible resource obligation. Test all three rather than conflating task and process state.
5. **Watcher event labels and backend composition:** Task 5's file list omits `packages/installer/src/watch.ts`, which currently labels HQ `agent.started/resumed` as worker start/resume. Include that renderer, and ensure dashboards/progress projections do not retain the old meaning. Task 3 may keep relay-local RPC in this increment, but it should still unify CLI executable/target resolution with catalog/tool discovery.

These are bounded contract/ownership additions, not reasons to replace the relay architecture. The selected active-attempt cap intentionally permits more than 10 retained agent processes; it satisfies the draft's definition, not an OS-wide process ceiling. Native session restoration after process release remains conditional on attested Orca support and must not be implied by the existing HQ thread ID.
