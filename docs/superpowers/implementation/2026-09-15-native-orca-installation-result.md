# Native Orca production installation result (2026-09-15)

Status: **installed and healthy**. Task 5/6 source was committed, the production HQ gateway was
backed up and restarted on matched artifacts, and the live additive migration/recovery barrier was
verified. This was a release acceptance pass, not the full Task 7 live 10+1/GUI campaign.

## Committed checkpoint

- `2abf5155e8e38c8c332c89019549640fb6f25b04` — `feat(hq): complete native Orca migration and recovery`
  (29 exact Task 5/6 allowlisted files, 2022 insertions/59 deletions, `git diff --check` clean).
- `a98e43f0d0083fd0b0fec5e677a00beeebaf25a5` — `fix(hq): accept nullable Orca terminal titles`.
  Orca 1.4.201 returns `title: null` for an otherwise live terminal. The production parser had
  accepted only string/undefined, so the first restart failed closed before readiness. A focused
  regression reproduced that exact Zod failure (1 failed/9 passed), the minimal nullable-as-missing
  parser fix then passed all 10 relay-coordinator tests, and the safe 15-of-16 workspace build passed.
- No push was performed.

## Installed identity and allowlists

- Install root: `/Users/j.jaeyo/Applications/orca-hq`.
- CLI: `/Users/j.jaeyo/.local/bin/hq`; its existing managed wrapper still points to that root.
- Service: launchd label `com.orcahq.gateway`; gateway entry
  `/Users/j.jaeyo/Applications/orca-hq/apps/gateway/dist/entry.js`.
- Built-artifact identity: every file under these 15 scoped output trees is byte-identical to the
  build from `a98e43f` (manifest comparison passed):
  - `apps/gateway/dist`, `apps/web/dist`
  - `packages/codex-hq/dist`, `packages/core/dist`, `packages/installer/dist`
  - `packages/observability/dist`, `packages/orca-adapter/dist`, `packages/persistence/dist`
  - `packages/project-registry/dist`, `packages/slack-adapter/dist`, `packages/tailscale-adapter/dist`
  - `packages/telegram-adapter/dist`, `packages/test-support/dist`, `packages/voice/dist`,
    `packages/worker-routing/dist`
- Installed source allowlist (and only this source allowlist) was synchronized: `README.md`,
  `apps/gateway/src/{managed-runtime,native-coordinator,progress-runtime,progress-store,relay-coordinator}.ts`,
  `packages/core/src/pilot-config.ts`, and
  `packages/installer/src/{chat,cli,progress-client,setup,watch}.ts`.
- The installed Git/source tree predates Tasks 1-4 and contains preserved historical changes. It is
  **not** claimed to be a clean checkout of `a98e43f`; production identity is the complete matched
  dist closure above. No broad source copy or checkout was used. `apps/gateway/src/native-coordinator.ts`,
  `apps/web/dist`, and `packages/observability/dist` were absent before and are recorded as such for
  scoped rollback cleanup.

## Backup and restart

- Backup root (mode 0700):
  `/Users/j.jaeyo/Library/Application Support/orca-hq/backups/release-2026-09-15T04-47-23Z-2abf515`.
- It contains the exact overwritten installed-source files, all pre-existing scoped dist trees,
  the CLI wrapper and launchd definition, and mode-0600 snapshots of `pilot.json`,
  `managed-owner.json`, and `relay-coordinator.json`.
- SQLite's online backup API captured `progress.sqlite`, `orca-relay.sqlite`, `control.sqlite`, and
  `managed-control.sqlite`; every resulting database passed `PRAGMA integrity_check`.
- Normal restart commands: `hq stop`, wait for the prior PID to exit, then `hq start`. The prior PID
  was 16888 (started 2026-09-08 14:01:55 KST). After the nullable-title compatibility fix, launchd
  started PID 31689 at 2026-09-15 13:55:41 KST.

## Before/after and live acceptance

- Before: four database stores were intact, all legacy `dispatches` tables had zero rows, the three
  existing request-context identities were present, and the pre-native progress database had no
  `hq_worker_*` tables.
- After: `GET http://127.0.0.1:4310/health` returned HTTP 200 with
  `service=orca-hq`, `mode=managed`, `state=running`, and the exact launchd PID 31689.
- `hq status` reported running/PID 31689. `hq jobs list` returned exit 0 through the actual local
  control socket, proving the harmless read-only CLI/control path.
- The live progress database has the additive `request_contexts.execution_backend` column; all three
  pre-existing assignments are `legacy_conversation`, and their exact request/part/context/source
  identities match the pre-restart online backup. There were no context-job/Dispatch identities
  before or after.
- `hq_worker_coordinator.ready=1` at epoch 4. Native occupied attempts are 0, exactly as before, so
  no active/unknown attempt was lost, replaced, replayed, or duplicated. All four live databases
  pass `PRAGMA integrity_check` after restart.

## Rollback and remaining gaps

- If the new binaries must be rolled back, first stop new admission and take a fresh SQLite online
  backup of the **latest** production databases. Restore only the prior compatible scoped source/dist
  files (and remove the three paths recorded absent-before), then restart the old gateway against the
  latest databases. This migration is additive and the prior reader ignores the new column.
- The release backup databases are disaster-recovery evidence, not a normal binary rollback input.
  Never restore them over a live/latest database containing newer active, unknown, or completed work;
  database restoration must use SQLite's backup API and is allowed only when no newer work would be
  discarded.
- A real native smoke task was deliberately not launched: the registered contexts are real projects,
  not an explicitly disposable no-file-change target. Therefore actual native launch/result, GUI
  visibility, full mixed-channel 10+1 admission, unlimited mode, and operator-observed terminal reuse
  remain Task 7. No Slack/Telegram/external message was sent.
