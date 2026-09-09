# Native Orca installed-state audit

Date: 2026-09-08 (Asia/Seoul). Scope: read-only comparison of the installed checkout at
`/Users/j.jaeyo/Applications/orca-hq` with the working checkout at
`/Users/j.jaeyo/Project/ETC/orca-hq`, plus bounded live status/health and executable identity checks.

## Executive verdict

**HQ and Orca are running and their health checks pass, but the installed product does not implement the
latest native-first contract.** The deployed source and compiled artifacts match the relevant files in the
working checkout, so this is not merely a stale installed build. The running behavior still routes
substantive context work through `conversation.execute()`, limits five active **contexts**, launches fresh
native workers as hardcoded Codex without a requested model/effort profile, and defaults to opening a
separate macOS Terminal `hq watch` viewer.

The authoritative capacity contract is: `maxActiveWorkers` has an **initial configurable default of 10**,
accepts a positive safe integer or explicit `"unlimited"`, and has no fixed maximum of 10. That contract is
absent from installed source, compiled output, and persisted pilot configuration schema.

## Live installed evidence

| Check | Observed state | Interpretation |
|---|---|---|
| `orca status --json` | Orca app running, runtime `ready`/reachable/connected, graph `ready`, app version `1.4.197` | Public Orca runtime is available and advertises orchestration contract and worker launch-preference capabilities. This is runtime readiness, not proof that HQ uses the new native-first path. |
| `hq status` | `running`, PID `16888` | HQ gateway launchd service is live. |
| `hq doctor --format json` | Overall `ok: true`; all enabled checks pass; OpenAI voice is intentionally skipped because disabled | Current pilot schema, host/runtime, Orca capabilities, agent authentication, channel connectivity, Keychain, SQLite, launchd, discovery, and registry checks are healthy. |
| launchd identity | Label `com.orcahq.gateway`; PID `16888` | The service is the expected HQ gateway. |
| service command | Node 22.23.2 executes `/Users/j.jaeyo/Applications/orca-hq/apps/gateway/dist/entry.js` | The running service uses the installed checkout, not the working checkout. |
| `hq` launcher | `/Users/j.jaeyo/.local/bin/hq` executes Node 22.23.2 with `/Users/j.jaeyo/Applications/orca-hq/packages/installer/bin/hq.js` | CLI and service both resolve to the installed checkout. |
| pilot metadata | Mode `0600`; schema doctor check passes; top-level keys are `schema`, `databasePath`, `projectRegistryPath`, `credentialAccounts`, `voiceMode` | No secret values were displayed or recorded. There is no installed capacity/profile/retention field. |

## Installed checkout versus working checkout

The installed checkout is branch `dev` at `94434cf07512`; the working checkout is branch `main` at
`aa65f85d5915`. Both contain substantial pre-existing uncommitted work. Despite different branch heads,
byte comparison found the following relevant source files identical between the two paths:

- `apps/gateway/src/agent-tools.ts`
- `apps/gateway/src/context-executor.ts`
- `apps/gateway/src/managed-observe.ts`
- `apps/gateway/src/managed-service.ts`
- `apps/gateway/src/orca-relay.ts`
- `apps/gateway/src/progress-runtime.ts`
- `apps/gateway/src/relay-coordinator.ts`
- `packages/installer/src/chat.ts`, `cli.ts`, `index.ts`, `progress-window.ts`, `prompt.ts`

The corresponding compiled artifacts are also byte-identical between installed and working checkouts:

- gateway: `context-executor.js`, `progress-runtime.js`, `orca-relay.js`, `relay-coordinator.js`, `entry.js`
- installer: `progress-window.js`, `watch.js`, `chat.js`, `cli.js`
- model protocol: `packages/codex-hq/dist/protocol.js`
- launch chain: `packages/installer/bin/hq.js`

Targeted source-to-build inspection also found the same decisive semantics in the installed compiled files.
This supports an installed-state conclusion without running builds or tests.

## Contract comparison

### 1. Native-first execution: not implemented

- `apps/gateway/src/managed-runtime.ts:228` and `:288` still wire execution to
  `conversation.execute(input)`. The conversation model has execution tools, so substantive work is not
  deterministically forced into a native Task/Dispatch.
- `apps/gateway/src/orca-relay.ts:784` can create an Orca Task and `:646` can call `worker-start`; this is a
  useful native foundation, but it is downstream of the optional conversation/tool path.
- The latest plan requires every development, analysis, and review instruction to use an actual Orca
  Task/Dispatch with no hidden local-model execution fallback. The current wiring does not guarantee that.

### 2. Capacity: old five-context mechanism, not configurable worker admission

- `apps/gateway/src/context-executor.ts:12` uses `options.maxContexts ?? 5`.
- The executor counts context identities in memory and `:45` rejects a second native worker for a context.
  This differs from global active/launching/uncertain HQ-managed **worker** admission across all contexts
  and channels.
- `apps/gateway/src/progress-runtime.ts:57` exposes only the internal optional `maxContexts`; the production
  composition does not pass a configured value, so the installed default is five.
- Targeted search found no `maxActiveWorkers` in installed or working `apps`, `packages`, or `templates`,
  including compiled output. The strict pilot and gateway schemas contain no such field, no positive-safe-
  integer validation, and no `"unlimited"` mode.

### 3. Agent/model selection: hardcoded or absent

- `apps/gateway/src/orca-relay.ts:625-626` always appends `--agent codex` for a fresh worker.
- The same launch command supplies no `--model` or `--effort`, stores no requested/effective launch
  profile, and has no role-based Codex/Claude selection or retained-terminal reuse branch.
- Separately, `packages/codex-hq/src/protocol.ts:11-16` fixes the HQ authority/assistant protocol models to
  `gpt-5.6-sol` and optional `gpt-5.6-terra`. Those HQ conversation constants do not satisfy the planned
  per-worker configurable launch-profile contract.
- No live worker was submitted in this audit, so the provider's effective subscription-default worker
  model was intentionally not inferred.

### 4. Actual Orca terminal versus macOS watch terminal: still conflated in default UX

- Actual worker execution, when selected, is launched through Orca `worker-start` in
  `apps/gateway/src/orca-relay.ts:646`; that is the Orca agent terminal/Dispatch path.
- `packages/installer/src/cli.ts:154` separately defaults `hq chat` to progress-window mode `auto`.
- `packages/installer/src/chat.ts:35` enables automatic windows unless explicitly `off`, and
  `packages/installer/src/progress-window.ts:22-25` uses AppleScript to open/activate macOS Terminal.
  The command placed there is `hq watch` (`progress-window.ts:50-52`), an observer, not the native worker.
- The latest contract instead defaults to no macOS watch window and shows receipt-backed actual Orca
  agent/model/terminal/task identity. The installed job/display types do not expose that complete identity.

## Limits of this audit

- No HQ job/request was submitted, no user prompt or job list was inspected, and no Slack/Telegram message
  was sent. Therefore this report does not claim endpoint-to-worker acceptance or a live effective model.
- No tests, build, install/update, service restart, database mutation, commit, push, terminal injection, or
  GUI automation was performed.
- No secret/config token values were displayed. Only configuration key names and non-secret schema
  metadata were inspected.
- No broad recursive hash was used. Comparisons were limited to the named relevant source/build files.
- Health passing means the current installed contract is internally ready; it is not evidence that the new
  native-first/default-10/configurable-unlimited contract has been implemented.

## Readiness conclusion

The installation is operational on its current contract and is not suffering from a working-versus-installed
artifact mismatch. It is **not ready to claim native-first completion or the new worker-admission policy**.
Implementation, matched rebuild/install, restart reconciliation, and bounded real HQ-to-Orca acceptance are
still required under separate authorization.
