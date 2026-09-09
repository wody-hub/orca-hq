# HQ context progress verification

Status: implemented, reviewed, installed and verified on 2026-09-08. Final service PID 57705 is healthy; desktop and model/native validation boundaries are recorded below.

## Orchestration

Run: `run_13fc633f1cf3`. Storage: Codex GPT-5.6 Sol high. Runtime: Codex GPT-6 Astra high. CLI began with Claude Opus high; the provider reported an individual spend limit at 11:54 with reset at 14:30. Its partial implementation was preserved. Native worker readback after stop reported failed/process_exited and the exact terminal disconnected/not writable; release conservatively retained the resource with `identity_unproven`. A retry of the same CLI task started successfully on Codex GPT-6 Astra high: Dispatch `ctx_38f7b8ff3051`, terminal `term_dc058ba9-58b6-4dc9-97f7-7a48335a100b`.

## Coordinator integration checks

Command at 11:58:54 KST:

```sh
pnpm exec vitest run tests/e2e/context-progress.spec.ts tests/chaos/context-progress-restart.spec.ts
```

Result: 2 files, 6 tests passed. These use the real SQLite store, context runtime, owner Unix socket control server and installer progress client; only model execution and native observations are injected fixtures.

| Behavior | Evidence |
| --- | --- |
| Five overlapping executions, sixth waits; same-context followup serializes | `tests/e2e/context-progress.spec.ts` holds five execution callbacks concurrently and checks peak 5, FIFO admission, responsive HTTP and six distinct contexts |
| Native work retains its slot and checkout ownership after HQ response | Same test file observes resource wait, recovery-required native state, and release only after terminal state |
| Viewer disconnect does not cancel or resubmit work | Same test file releases viewer lease, replays stored context events by cursor and confirms exactly one execution |
| Model failure does not alter another context | Same test file checks independent running and completed states/results |
| Long Korean result and retained request identity survive event compaction | Same test file validates full stored result and idempotent repeated POST after pruning |
| Restart reopens queued work without replaying interrupted native work | `tests/chaos/context-progress-restart.spec.ts` closes/reopens the database, resumes unstarted work and retains unknown native reservation |

These tests establish cross-component behavior with controlled execution. They do not claim live model classification quality, real simultaneous Orca workers, or GUI window behavior.

## Installation preparation

- Original installed source/build/package metadata backed up to `/Users/j.jaeyo/.config/orca-hq/backups/context-progress-20260908-115308` with a manifest. Installed app has not yet been updated with this feature.
- Targeted source comparison found installed legacy control timeout 240 seconds versus repository 60 seconds. Repository `packages/installer/src/control.ts` now preserves the installed 240 seconds. New progress submission uses a separate client.
- Read-only Terminal AppleScript preflight succeeded; it reported 3 preexisting windows.

## Actual CLI and window-process check

At 12:08–12:13 KST the coordinator ran the built `hq chat` in a real PTY against an isolated gateway fixture at `/tmp/hqgui-P18i80`. Its model callback was a four-second fixture; the Unix socket, storage, router/executor, installer CLI, Terminal launcher, and `watch` processes were actual implementations.

- Two consecutive instructions returned durable acceptance without waiting for the first result. Execution A began at `03:08:03.946Z` and B at `03:08:03.950Z`; both ran until approximately `03:08:07.95Z`.
- Terminal launch returned success for two different contexts. OS process inspection confirmed actual watch PIDs 96587 (A) and 96577 (B), and both maintained server viewer leases.
- Selecting A and submitting a followup produced `진행 창 재사용`; the same watch PID and context were retained.
- A subsequent A request started at `03:09:14.573Z`. SIGINT was sent only to its verified test viewer PID while the callback was running. The request completed at `03:09:18.575Z` and retained its result.
- A new explicit followup reopened A with a new lease/viewer PID 25546; B's viewer remained independent.
- A partially typed Korean input line survived assignment, window-reuse and final-result notifications in the actual PTY.
- `/exit` detached cleanly. The coordinator then stopped only the verified fixture viewer processes and fixture server; their data remains available as verification evidence.

Computer Use rejected access to `com.apple.Terminal` for safety reasons. No alternative UI inspection was attempted after that restriction. These checks prove actual launcher/process/lease behavior and PTY rendering, but do not claim screenshot inspection, window geometry, or the behavior of clicking Terminal's close button. SIGINT tested viewer exit instead.

## Test isolation incident

The replacement CLI worker reported that an initial red test accidentally used the old default `/commands` transport before a guard was added. Read-only inspection found four matching completed local terminal receipts in session `session`: `첫 질문` twice, `질문`, and `하나`. They had no job ID/job IDs and no matching `hq_agent_effects` mutation records. The records were preserved; current tests inject the transport and the real PTY test uses a separate temporary fixture. No Slack or Telegram test message was sent.

## Worker final verification reports

- Runtime owner reported gateway build, repository typecheck and 271 gateway/integration tests passed before handoff to real-model validation task `task_fc66493b8c53` / Dispatch `ctx_a6113931a341`.
- Storage owner reported `pnpm typecheck`, `pnpm test` (84 files / 1032 tests), and recursive build passed before handoff to independent runtime review task `task_d1497b811e1f` / Dispatch `ctx_83a7d8bb2bc2`.
- These precede the final CLI multiline-rendering additions; a final consolidated check remains required.

## Final integration and release history

### Consolidated checkpoint and independent review (12:16–12:26 KST)

- Consolidated `pnpm typecheck`, `pnpm test` (85 files / 1039 tests), and `pnpm build` passed before the final retention/review corrections.
- Actual Codex validation passed with five independent `gpt-6-astra` threads sharing 16.281 seconds of concurrent execution; thread resume and semantic routing also passed. See `2026-09-08-progress-live-model-validation.md` for measured timestamps and fixture boundaries.
- Independent review found six gaps despite the passing suite. Findings 1/4/6 (complete retry resource ownership, per-part multipart outcomes, retention) are assigned to `ctx_b7309770a1ba`; findings 2/3/5 (legacy retry ownership, pending native launch crash recovery, responsive guidance) to `ctx_c215ae525e01`. See `2026-09-08-progress-runtime-review.md`.
- A coordinator-owned real-socket multipart test was added at 12:24. Its initial predicate missed the runtime's original-constraint prefix and was corrected after worker feedback. The valid 12:26 run reproduced the defect: the successful context received `request.failed` instead of `request.completed`; the five existing tests passed. This red regression must pass after correction.
- Installation preflight found no installed drift since backup and no installed-only files in the three scoped package source/build trees. Feature artifacts remain uninstalled at this checkpoint; the current service is healthy with an empty running/queued managed-command queue.
- At 12:35 the coordinator independently reran both socket integration and chaos suites after the multipart correction: 2 files / 7 tests passed, including the previously red successful-context final event assertion. Relay corrections and consolidated release checks were still in progress.

## Final results (12:45–12:51 KST)

- All six independent review findings were corrected. Runtime correction evidence is in `2026-09-08-progress-runtime-fixes.md`; native relay corrections are in `2026-09-08-progress-relay-fixes.md`. A final coordinator check tightened unknown-dispatch recovery: observing a different dispatch alone never acquires cleanup ownership. Only the exact ID already persisted from a successful launch receipt can reconcile automatically.
- Final `pnpm test`: **85 files / 1066 tests passed** (12:50:58, exit 0). An earlier concurrent run had one 5-second documentation-probe timeout; its isolated 5-test rerun passed in 57ms, and subsequent full sequential runs passed. No timeout assertion was loosened.
- Full repository typecheck and recursive build passed. The final readiness-only correction additionally passed installer source/test typechecks, installer build, and 66 readiness/CLI/launchd tests. Scoped diff whitespace checks passed.
- Installed **125** reviewed source/build files in gateway/core/installer, each byte-verified against the workspace and recorded with hashes in `~/.config/orca-hq/progress-install-applied.json`. Original files remain in `~/.config/orca-hq/backups/context-progress-20260908-115308`. Existing coordinator recovery and the installed legacy 240-second control timeout were preserved.
- First restart exposed the existing default 15-second readiness deadline: native restoration took longer, so CLI startup stopped the service. Explicit launchd bootstrap restored service. The coordinator reproduced the issue with a synthetic 20-second readiness test, increased the bounded default to 60 seconds, and installed the tested correction. A subsequent ordinary **`hq stop` / `hq start` succeeded in 20.519 seconds**, with no bootstrap workaround.
- Final `hq status` reports running PID **57705**. `/health` reports `running`, Slack and Telegram connected, and no queued/running managed commands. No Slack/Telegram verification message was sent.
- Installed real-model smoke request `install_smoke_1a07f227ec9` was durably accepted in **8.125ms**. Its context was assigned approximately **11.892 seconds** after acceptance and its complete response was stored approximately **22.101 seconds** after acceptance. This separates model classification/execution latency from immediate durable acceptance. Context `ctx_99d20e12619dc2861610ba5c8a459470` retained the complete multiline result.
- The smoke reviewed only an inline pure function. Persisted events contained acceptance, assignment, agent start, and per-context/aggregate completion; no tool event or native job was created. After the successful restart, GET returned the same completed request, context ID and original result without resubmission. Raw local evidence: `/tmp/orca-hq-installed-progress-smoke.json`.
- Every successful implementation/review/fix Dispatch was settled and its exact terminal released or immediately transferred to its next assignment. The earlier quota-failed Claude attempt remains conservatively retained by Orca as identity-unproven, with no forced close. No commit or push was performed.

## Verification limits

- Actual Codex threads, actual SQLite/socket scheduling, and actual Terminal launcher/viewer processes were verified separately. This does not claim a single end-to-end test with five real native coding workers.
- Computer Use rejected Terminal UI access; no workaround bypassed that restriction. Window geometry, screenshots and clicking the close button remain unverified. Actual launcher/process/lease behavior and viewer SIGINT were verified.
- Usage is documented in the repository README. Progress windows are observers; closing them or exiting chat does not cancel work. Unproven native outcomes remain recovery-required rather than being replayed.
