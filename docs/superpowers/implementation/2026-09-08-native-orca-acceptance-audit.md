# Native Orca acceptance audit

> Coordinator reconciliation (after worker completion): This report preserves an independent review of the old implementation and alternative lifecycle recommendations. The final `../specs/2026-09-08-hq-native-orca-agents-design.md` and `../plans/2026-09-08-hq-native-orca-agents.md` control implementation. N1 uses a new agent terminal in the existing exact checkout by default; a new worktree requires justification. Primary-terminal retention/reuse is a proposed first-release feature pending user preference, not deferred future scope. Default chat opens no watch window. Release-pending/unknown remains counted until cleanup proof or confirmed retained-idle disposition. New test ownership is `apps/gateway/test/worker-admission.test.ts` and `tests/e2e/native-orca-progress.spec.ts`; the alternate names below are audit suggestions, not additional duplicate modules. Existing 73 passing tests prove the previous behavior only.

Date: 2026-09-08  
Scope: planning-only review of the managed gateway, installer chat/progress viewers, native Orca relay, and their tests.

## Release verdict

**Not yet verifiable for the requested contract.** The repository has strong deterministic coverage for five progress contexts, exact Dispatch recovery, active-worker follow-ups, checkout exclusion, chat detachment, and viewer leases. It does not have one durable admission boundary enforcing **at most 10 active HQ-managed native workers across every channel and every fan-out part**, and it has no release gate proving ten real Orca project-agent terminals plus an eleventh queued request in the Orca GUI.

The current behavior must not be described as the requested global limit:

- `apps/gateway/src/context-executor.ts:11-38` defaults to five occupied progress contexts, not ten native workers.
- `apps/gateway/src/managed-runtime.ts:133-174` sends both legacy channel and progress work to one relay, but only progress work owns execution reservations.
- `apps/gateway/src/orca-relay.ts:602-672` can start every authorized background request and has no atomic global capacity claim immediately before `worker-start`.
- `apps/gateway/src/orca-relay.ts:799-901` correctly avoids a new worker for an active same-Dispatch follow-up, but a settled follow-up creates another Task and fresh worker in the existing worktree.
- `apps/gateway/src/orca-relay.ts:499-522` releases an owned settled worker during observation. There is no completed-terminal transfer/reuse policy before that release.
- `apps/gateway/src/orca-relay.ts:618-648` hard-codes `codex` and does not request or validate an effective model/effort.

## Acceptance contract

Count an HQ worker slot from the durable `worker-start` intent immediately before the external call until exact authoritative evidence proves the Dispatch settled (`succeeded`, `failed`, or `stopped`). A lost start response, `outcome_unknown`, incomplete inventory, or unproven terminal identity continues to consume a slot. Tasks without a started/provisional worker, model-only routing turns, coordinator terminals, setup terminals, progress viewers, released terminals, and user-owned terminals after an authoritative lifecycle handoff do not consume a worker slot.

The cap is global to the one HQ installation, not per Slack thread, Telegram chat, terminal session, Run, project, request, or progress context. Every fan-out part that can call `worker-start` competes for the same ten slots. Admission and FIFO queue order must be durable and transactional; a process-local counter or a count derived only from cached job snapshots is insufficient.

Lifecycle policy for the pilot should be explicit and simple:

1. Guidance to a running context targets `dispatch:<exact-id>` and creates no Task, terminal, or slot.
2. A settled owned worker is released by default. A later continuation reuses the exact checkout but creates a new Task, Dispatch, and agent terminal; it is **not** advertised as resuming the completed terminal session.
3. Exact completed-terminal reuse is optional future behavior. If required, it must transfer the terminal directly to the next Dispatch with `worker-start --terminal <handle>` before release and have separate acceptance evidence.
4. `worker-retain` is used only after an explicit user request. A user takeover or identity-unproven release retains the terminal without force-closing it, while the settled Dispatch no longer consumes an HQ slot.

## Verifiable scenarios

| ID | Scenario and observable pass condition | Required failure oracle | Current evidence |
| --- | --- | --- | --- |
| N1 | Submit one bounded job for a disposable registered project. Orca shows a new top-level project worktree and one actual Codex agent terminal; `worker-show` returns the same Task, Dispatch, worktree, and `agent_terminal_handle` as `terminal list --include-visual-layouts`. | No shell-only fallback, hidden worker, duplicate terminal, wrong project, or success based only on a mocked receipt. | **Partial:** relay argument coverage in `apps/gateway/test/orca-relay.test.ts` (“creates native identities once…”); no real GUI correlation. |
| N2 | While N1 is running, send two same-context guidance requests with distinct request IDs. Exactly two ordered `send --to dispatch:<id>` effects occur, zero additional `worker-start` calls occur, and active count is unchanged. | Duplicate request ID is idempotent; lost send receipt becomes delivery-unknown and never starts a replacement worker. | **Partial:** `apps/gateway/test/orca-relay.test.ts` proves one idempotent duplicate and guidance responsiveness, but not two distinct ordered deliveries or a live worker. |
| N3 | After authoritative `worker_done`, with no continuation already queued, HQ calls `worker-release` once. A later same-context continuation uses the same worktree but a new Task, Dispatch, terminal handle, and slot. | The old terminal must not be silently reused, retained, or force-closed through a generic terminal command. | **Partial:** release and settled follow-up paths exist; their combined lifecycle is not asserted end-to-end. |
| N4 | Optional immediate reuse test, only if the product chooses it: queue continuation before processing completion, then transfer the exact terminal to a new Dispatch before release. | Releasing first, reusing a different terminal, preserving the old Dispatch ID, or double-counting during transfer fails. | **Missing and not recommended for pilot default.** |
| N5 | Close an active Orca agent terminal from the UI. HQ observes the exact Dispatch as stopped/failed or recovery-required, does not auto-retry, and admits a queued worker only after the slot disposition is authoritative. | A task-level Dispatch with a different ID, TUI idle, stale handle, or missing terminal is not completion proof. | **Partial:** unknown/restart fail-closed relay tests; no real user-close test. |
| N6 | Take over a settled worker terminal from the UI, then let HQ release it. Orca reports retained/user-taken-over, the terminal stays visible and usable, no `terminal close` occurs, and the settled Dispatch frees the HQ slot. | Active or ambiguous Dispatches never free capacity merely because a human typed in or focused the terminal. | **Missing.** Orca lifecycle semantics are not exercised by gateway tests. |
| N7 | Submit fan-out work from synthetic Slack, Telegram, and local terminal ingress so 11 independent parts become native-ready. Exactly 10 provisional/active HQ workers exist, the eleventh remains durably FIFO-queued, and only 10 project agent terminals exist. | Per-channel caps, 11 `worker-start` calls, or an eleventh terminal before settlement fail. No external Slack/Telegram message is needed; use local adapter ingress. | **Missing.** Existing tests prove five progress contexts only. |
| N8 | Settle one of the ten with exact Dispatch evidence. The oldest globally queued part claims the freed slot once; peak observed provisional plus active count never exceeds 10 under concurrent submissions. | A newer request overtaking the oldest, duplicate admission after callback replay, or a slot freed by unknown evidence fails. | **Missing.** |
| N9 | Restart the gateway with 10 active/provisional workers and one queued part. The same Run, Task IDs, Dispatch IDs, and worktrees are recovered; no `worker-start` is replayed and the eleventh remains queued. A gateway-only restart preserves worker handles; after an Orca runtime recovery, a changed handle is accepted only when `worker-show` proves it still belongs to the exact Dispatch. A replacement coordinator handle likewise requires proven tab/worktree recovery and Run rebinding. | Task-level matching, title-only ambiguity, incomplete inventory, or a lost response must never invent identity or create a duplicate. | **Partial:** `apps/gateway/test/relay-coordinator.test.ts`, `apps/gateway/test/orca-relay.test.ts`, and `tests/chaos/context-progress-restart.spec.ts`; no global-cap reconstruction test. |
| N10 | Send two write jobs to the same checkout through different channel origins, including a symlink/nested-path alias. Only one reaches `worker-start`; the other emits a durable resource-wait event and starts after exact release. Independent checkouts may run concurrently. | Unknown placement conflicts conservatively; stale completion cannot release the newer reservation. | **Partial:** `apps/gateway/test/execution-reservations.test.ts`, `apps/gateway/test/execution-compatibility.test.ts`, and `tests/e2e/context-progress.spec.ts` cover progress/progress and progress/legacy exclusion. Legacy/legacy same-checkout admission is not covered. |
| N11 | Make Codex unavailable/auth-failed before admission, and separately make the requested model unavailable after provisional admission. The request reports a bounded actionable failure, never substitutes another agent/model, releases only a definitely failed provisional slot, and preserves an uncertain start as recovery-required/counting. | Raw provider diagnostics, hidden fallback to Claude/default model, or automatic retry fails. | **Partial:** installer checks Codex auth and Orca status; worker routing tests reject provider substitution. Native relay does not validate effective launch identity/model. |
| N12 | From interactive `hq chat`, enter a second request before the first completes. Each accepted fan-out context gets at most one viewer, same-context activity reuses its lease, `/exit` and viewer close detach observation only, and work/slots continue. | Piped/SSH/non-macOS runs open no GUI; uncertain AppleScript launch is not retried; closing a viewer never stops a worker. | **Covered deterministically and at PTY/process level:** installer chat, window, client, and watch tests. Click/geometry remain unverified. |
| N13 | Fail or time out `worker-release`. Completion stays visible, capacity follows the settled Dispatch rather than terminal disappearance, and cleanup remains pending/unknown without generic `terminal close`. | Cleanup failure must not rewrite work as failed, reopen a slot based on terminal closure, or lose inspectable output. | **Partial:** `orca-relay.test.ts` (“keeps native completion visible if cleanup is unavailable”); native release-pending/unknown receipts are not integrated. |

## Ten-plus-one deterministic test design

Add `tests/e2e/native-orca-admission.spec.ts` using the real SQLite stores, managed service, progress control socket, and relay with a controllable Orca port. Inject channel input locally without contacting providers: four synthetic Slack ingress jobs, three Telegram ingress jobs, and one terminal progress request routed into four native-ready parts. Gate every `worker-start` response after the durable intent is recorded.

The test must assert all of the following before releasing a gate:

- 11 distinct source-request/part launch identities and a single HQ-wide queue order.
- Exactly 10 `worker-start` calls and 10 unique Dispatch/terminal identities.
- The eleventh launch has a durable queued admission record, no Dispatch ID, and no terminal. When it is a progress part, it also has an `agent.waiting` event with reason `capacity`.
- Replaying any ingress/request ID does not change calls, count, or order.
- A running follow-up to any admitted context uses one `send` call and no slot.
- Exact settlement of worker 4 starts the eleventh once; settlement replay changes nothing.
- Peak `provisional + active` recorded inside the admission transaction is 10.

Run the same fixture with all 11 arriving concurrently. Run a second variant where the tenth `worker-start` response is lost: it remains counted and the eleventh remains queued across store close/reopen until exact worker inspection resolves that same Dispatch.

## Exact file and test mapping

| Responsibility | Production file(s) | Existing proof to retain | Required addition |
| --- | --- | --- | --- |
| Global native admission and durable FIFO | `apps/gateway/src/orca-relay.ts`; proposed focused module `apps/gateway/src/native-worker-admission.ts`; `apps/gateway/src/managed-runtime.ts` | None | `apps/gateway/test/native-worker-admission.test.ts`; `tests/e2e/native-orca-admission.spec.ts` |
| Fan-out and same-context serialization | `apps/gateway/src/context-router.ts`; `apps/gateway/src/progress-runtime.ts`; `apps/gateway/src/context-executor.ts` | `apps/gateway/test/context-router.test.ts`; `apps/gateway/test/context-executor.test.ts`; `tests/e2e/context-progress.spec.ts` | Change capacity copy/tests to distinguish model-context capacity from the global native-worker cap; add cross-channel fan-out assertions. |
| Native Task/Dispatch creation, active guidance, retry, release | `apps/gateway/src/orca-relay.ts` | `apps/gateway/test/orca-relay.test.ts` | Add settled-follow-up release/fresh-terminal, takeover, release-pending/unknown, and global-slot assertions. |
| Restart and exact coordinator/worker identity | `apps/gateway/src/relay-coordinator.ts`; relay SQLite request/snapshot metadata | `apps/gateway/test/relay-coordinator.test.ts`; unknown-start cases in `orca-relay.test.ts`; `tests/chaos/context-progress-restart.spec.ts` | `tests/chaos/native-orca-restart.spec.ts` with ten active, one queued, changed coordinator handle, and zero replayed starts. |
| Checkout write exclusion across old/new channel paths | `apps/gateway/src/execution-reservations.ts`; `apps/gateway/src/execution-compatibility.ts`; `apps/gateway/src/progress-store.ts` | `apps/gateway/test/execution-reservations.test.ts`; `apps/gateway/test/execution-compatibility.test.ts`; native ownership case in `tests/e2e/context-progress.spec.ts` | Add legacy/legacy and mixed two-ingress same-worktree plus symlink alias cases before the real `worker-start` boundary. |
| Agent/model readiness and exact effective launch | `packages/installer/src/host.ts`; `packages/installer/src/doctor.ts`; `apps/gateway/src/orca-relay.ts`; `packages/orca-adapter/src/receipts.ts` | `packages/installer/test/doctor.test.ts`; `packages/orca-adapter/test/capabilities.test.ts`; provider-selection tests | Validate a documented read-only agent inventory, parse `launch.requested/effective`, add no-substitution and unavailable-model admission tests. |
| Chat, progress viewer, and observation-only close | `packages/installer/src/chat.ts`; `packages/installer/src/progress-window.ts`; `packages/installer/src/watch.ts`; `packages/installer/src/progress-client.ts` | `packages/installer/test/chat.test.ts`; `packages/installer/test/chat-pty.test.ts`; `packages/installer/test/progress-window.test.ts`; `packages/installer/test/progress-client.test.ts`; `packages/installer/test/watch.test.ts` | Add a manual macOS click-close record; no product retry or worker cancellation should be observed. |
| Real Orca terminal and GUI gate | Orca runtime plus the built gateway/installer | No automated repository test currently proves visibility | Maintain an external, redacted acceptance evidence directory containing CLI JSON, timestamps, screenshots, and a terminal-handle correlation manifest. Do not commit user terminal contents. |

## Real native and GUI release gate

Use disposable repositories containing no credentials and bounded tasks that wait on a harmless local gate. Build/install the exact candidate, record `orca status --json`, gateway build identity, and the configured Codex authentication check before starting. Do not infer agent/model identity from a title: record the validated `worker-start` receipt, `worker-show`, and the agent's native session metadata.

For Orca project terminals, verify the Orca application itself: correlate each of the ten `agent_terminal_handle` values with its project/worktree and a visible sidebar/tab/pane, capture one redacted overview screenshot, and prove the eleventh has neither a handle nor a pane. After one exact completion, capture the promoted eleventh terminal and the unchanged nine others. Accessibility-tree inspection alone is insufficient if it omits terminal panes; CLI identity alone is insufficient to claim visibility.

For installer progress windows, keep the prior limitation explicit. Automated tests and process inspection can prove AppleScript invocation, watch PID, lease ownership, stream rendering, and SIGINT behavior. They do not prove window geometry, focus, or clicking the macOS Terminal close control. If desktop automation is denied access to Terminal, mark the click-close criterion **manual/unverified**, have an operator close one disposable viewer, and verify through lease/process/event evidence that its native worker continues. Never replace the missing GUI observation with a screenshot claim.

## Recommendations in priority order

1. Add one durable native admission ledger at the relay boundary and set its constant to 10. Acquire immediately before `worker-start`; preserve provisional/unknown entries across restart; release capacity only from exact settled Dispatch evidence.
2. Keep model-context scheduling and native-worker admission as separate concepts. Rename displayed/tested capacity accordingly so the existing five-context executor cannot be mistaken for the global worker limit.
3. Make release the completed-terminal default. Document that later continuation is a fresh agent terminal in the same checkout; implement exact terminal transfer only if a product requirement justifies its additional lifecycle states.
4. Validate worker-start receipts strictly, including exact Task/Dispatch/worktree and effective agent/model. Fail closed and do not substitute providers.
5. Add deterministic ten-plus-one, concurrent-arrival, lost-response, restart, user-close/takeover, and same-checkout cross-channel tests before attempting the live GUI gate.
6. Require one bounded live Orca acceptance run with real visible agent terminals. Keep macOS Terminal progress-window click verification as a separately labeled manual gate when UI automation cannot access it.

## Review evidence

Focused deterministic suite run from this checkout:

```text
pnpm exec vitest run apps/gateway/test/orca-relay.test.ts apps/gateway/test/relay-coordinator.test.ts apps/gateway/test/context-executor.test.ts apps/gateway/test/execution-compatibility.test.ts packages/installer/test/chat.test.ts packages/installer/test/chat-pty.test.ts packages/installer/test/progress-window.test.ts tests/e2e/context-progress.spec.ts tests/chaos/context-progress-restart.spec.ts
```

Result: **9 files, 73 tests passed** on 2026-09-08. This supports only the existing deterministic claims mapped above; it is not evidence for the missing global ten-worker or real-GUI gates.
