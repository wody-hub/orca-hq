# Orca HQ private pilot 운영 방법

이 문서는 설치를 마친 운영자가 gateway 장애, Mac/Orca 재시작, queue, approval expiry, backup, update, rollback, diagnostics, uninstall을 처리하는 절차입니다. 모든 명령은 repository root에서 실행합니다.

## 먼저 확인할 원칙

- Mac이 꺼지거나 sleep 상태이거나 네트워크가 끊기면 HQ도 동작하지 않습니다. 이를 24×7 cloud service로 취급하지 않습니다.
- SQLite, project checkout, worktree, Keychain을 수동으로 고치기 전에 gateway를 멈추고 active/uncertain Dispatch가 없는지 확인합니다.
- timeout, heartbeat 지연, TUI idle만으로 worker 실패를 단정하거나 terminal/worktree를 삭제하지 않습니다.
- `review_required`는 자동 retry/release 근거가 아닙니다. exact Orca receipt와 Git 상태를 운영자가 검토합니다.
- log와 diagnostic을 공유하기 전에 [data handling](../security/data-handling.md)의 redaction 절차를 따릅니다.

## 상태, 시작, 중지, 재시작

```bash
pnpm hq status
pnpm hq start
pnpm hq stop
```

`status`는 `running`, `loaded`, `stopped` 중 하나를 JSON으로 반환합니다. `stopped`는 exit 1입니다. `start`는 정확한 `com.orcahq.gateway` user LaunchAgent를 설치/시작하고, `stop`은 그 exact label만 bootout합니다.

별도 `restart` subcommand는 없습니다. graceful stop은 ingress를 닫고 local transaction을 drain하고 Outbox를 멈춘 뒤 SQLite checkpoint/close를 시도합니다.

```bash
pnpm hq stop
pnpm hq start
pnpm hq status
pnpm hq doctor --format json
```

## Mac이 offline 또는 sleep이었다가 돌아옴

1. Mac의 전원, sleep 해제, 네트워크, 승인된 tailnet 연결을 사용자가 직접 복구합니다.
2. Slack history와 Telegram Bot API에는 provider가 보존한 command가 남을 수 있지만 Tailscale web은 Mac이 offline인 동안 사용할 수 없습니다.
3. gateway를 시작하고 status와 doctor를 확인합니다.

```bash
pnpm hq start
pnpm hq status
pnpm hq doctor --format json
```

startup은 DB migration과 Keychain/Orca 검증 뒤 channel cursor를 재개하고, Outbox claim을 회수하고, nonterminal Dispatch를 Orca receipt와 대조합니다. command는 identity와 idempotency 검사를 거친 뒤 처리됩니다. 중복 실행을 피하려고 recovery 중 같은 command를 다시 보내지 않습니다.

## Orca 또는 Codex HQ가 unavailable

Orca 상태가 불확실하면 project mutation과 새 worker 시작을 중단합니다. Codex HQ가 unavailable이면 Claude가 HQ 권한을 대신하지 않고 새 command는 queue에 남습니다. active Orca worker의 완료 message도 Orca에 남습니다.

```bash
orca status --json
pnpm hq doctor --format json
pnpm hq status
```

Orca 앱과 자신의 인증을 복구한 뒤 gateway를 한 번 재시작합니다. 그 다음 HQ가 Run inbox를 reconcile하도록 기다립니다. exact Dispatch ID를 이미 알고 있고 review가 필요할 때만 read-only inspection을 사용합니다.

```bash
orca orchestration worker-show --dispatch <dispatch-id> --json
orca orchestration worker-read --dispatch <dispatch-id> --json
```

receipt의 Task/Dispatch identity가 local record와 일치하지 않거나 상태가 `unknown`, `missing`, `inconsistent`이면 retry, release, worktree 삭제를 하지 말고 intervention으로 올립니다.

## queued command와 Outbox 처리

- Slack/Telegram ingress 재연결 전에는 같은 command를 복사해 다시 보내지 않습니다. provider event ID 기반 idempotency가 원본 replay를 하나의 Command로 묶습니다.
- Outbox는 retry 가능한 provider 실패를 최대 5분 backoff로 다시 예약합니다. gateway restart 시 만료된 claim을 회수합니다.
- Task 완료와 channel delivery는 별도 상태입니다. 전달이 늦어져도 Task를 다시 실행하지 않습니다.
- DB row, cursor, `attempts`, `claimed_by`를 수동 변경하지 않습니다. gateway/Orca가 복구된 뒤에도 pending이면 redacted diagnostic과 exact audit reference를 수집해 issue를 만듭니다.

## approval 만료 또는 내용 변경

L2/L3 approval은 proposal, operation, command, diff hash, target environment에 묶이고 승인 시점부터 정확히 15분 동안만 유효합니다. 시간이 지났거나 project·branch·scope·diff·command·environment가 바뀌면 기존 approval을 재사용하지 않습니다.

- L2는 Slack/Tailscale의 owner 또는 operator가 승인합니다.
- L3는 Slack/Tailscale의 owner만 승인하고 generated operation phrase를 정확히 입력합니다.
- Telegram의 L2/L3 approval은 항상 거부됩니다.

원래 Slack thread 또는 Tailscale 화면에서 최신 preview와 digest를 다시 확인하고 새 approval을 요청합니다. expired/changed approval을 DB에서 되살리지 않습니다.

## log 확인

`logs` 이름은 CLI에 예약되어 있지만 private-pilot service adapter가 아직 구현되지 않았습니다. 다음 명령은 `hq logs is reserved for the private-pilot service adapter.`를 출력하고 exit 1로 끝납니다.

```bash
pnpm hq logs
```

현재는 launchd가 쓰는 두 로컬 파일을 직접 읽습니다. 공유 전에는 token, authorization, cookie, prompt, transcript, URL, 사용자 경로가 남지 않았는지 다시 검토합니다.

```bash
tail -n 200 "$HOME/Library/Logs/orca-hq/gateway.log"
tail -n 200 "$HOME/Library/Logs/orca-hq/gateway.error.log"
```

## gateway가 시작되지 않음

```bash
pnpm hq status
pnpm hq doctor --format json
tail -n 200 "$HOME/Library/Logs/orca-hq/gateway.error.log"
```

`doctor` remediation을 먼저 처리합니다. LaunchAgent path는 `~/Library/LaunchAgents/com.orcahq.gateway.plist`, label은 `com.orcahq.gateway`입니다. broad `kill`, 다른 LaunchAgent 삭제, user domain 전체 bootout을 사용하지 않습니다. plist의 Node path, gateway entry path가 현재 checkout과 다르면 program을 옮기지 말고 `pnpm hq start`로 exact definition을 다시 확인합니다.

## cold backup 만들기

독립 `hq backup` subcommand는 없습니다. update는 gateway를 멈춘 뒤 SQLite online backup, non-secret config, `manifest.json`을 `~/Library/Application Support/orca-hq/backups/<timestamp>/`에 자동 생성합니다. Keychain secret은 어떤 backup에도 포함되지 않습니다.

update 밖에서 수동 backup이 필요하면 먼저 active/uncertain work가 없음을 확인하고 gateway를 graceful stop한 뒤 cold copy를 만듭니다. custom `databasePath`를 썼다면 아래 기본값 대신 pilot JSON의 정확한 값을 사용합니다.

```bash
pnpm hq stop
CONFIG_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/orca-hq/pilot.json"
DATABASE_PATH="$HOME/Library/Application Support/orca-hq/control.sqlite"
BACKUP_DIR="$HOME/Library/Application Support/orca-hq/manual-backups/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir -p "$BACKUP_DIR"
cp "$DATABASE_PATH" "$BACKUP_DIR/runtime.sqlite"
cp "$CONFIG_PATH" "$BACKUP_DIR/pilot.json"
shasum -a 256 "$BACKUP_DIR/runtime.sqlite" "$BACKUP_DIR/pilot.json"
pnpm hq start
pnpm hq doctor --format json
```

backup directory 안에 token export, Keychain dump, raw attachment, raw transcript를 넣지 않습니다. `--remove-data` uninstall 전에 보존할 backup은 data directory 밖의 암호화된 사용자 전용 위치로 복사하고 hash를 재확인합니다.

## exact revision으로 update하기

먼저 upstream commit을 fetch하고 full 40/64-character commit SHA를 확인합니다. branch name, tag, abbreviated SHA는 거부됩니다.

```bash
git fetch --prune origin
pnpm hq update --revision <full-commit-sha>
```

update는 active/uncertain work를 두 번 확인하고, exact revision과 frozen lockfile을 설치하고, `pnpm typecheck` preflight 후 gateway를 멈춥니다. backup을 만든 뒤 migration, restart, read-only doctor를 실행합니다. 어느 단계든 실패하면 가능한 모든 prior program/database/config 복구와 prior gateway restart를 시도합니다. 성공 JSON의 `previousRevision`, `revision`, `backupId`를 change record에 남깁니다.

## rollback 검토와 수동 복구

자동 rollback 뒤에는 먼저 status, doctor, error log, backup `manifest.json`을 확인합니다. generic `Lifecycle operation failed.`만으로 현재 source와 DB를 추측하지 않습니다. manifest의 `sourceRevision`, `schemaVersion`, `databasePath`, `configPath`, `includesSecrets: false`가 서로 맞는지 확인합니다.

자동 rollback이 끝나지 않았다는 근거가 있고 repository owner가 수동 복구를 승인한 경우에만 다음 순서를 사용합니다. `<...>`는 검증한 manifest와 pilot JSON의 exact 값으로 바꿉니다.

```bash
pnpm hq stop
git checkout --detach <source-revision-from-manifest>
pnpm install --frozen-lockfile
cp "<backup-runtime-sqlite>" "<configured-database-path>"
cp "<backup-pilot-json>" "<pilot-config-path>"
pnpm hq start
pnpm hq doctor --format json
```

기존 실패 상태는 덮어쓰기 전에 별도 cold backup으로 보존합니다. program과 호환되는 database/config snapshot을 함께 복구하고, doctor가 정상일 때까지 새 update를 시작하지 않습니다.

## local redacted diagnostic 만들기

진단 export는 자동 전송되지 않습니다. 먼저 build한 뒤 사용자가 명시적으로 아래 local-only bundle을 만듭니다. 이 예시는 raw DB/log/config/Registry를 읽지 않고 safe status와 counter만 넣으며, path-like field는 완전히 redaction합니다.

```bash
pnpm build
DIAGNOSTIC_DIR=$(node --input-type=module <<'NODE'
import { diagnostics } from "./packages/observability/dist/src/index.js";
const bundle = await diagnostics.create({
  includeFullContent: false,
  health: { gateway: "needs-review", configPath: "local-only" },
  counters: { operatorObservedFailures: 1 },
  pathDisclosure: "redact"
});
console.log(bundle.stagingPath);
NODE
)
printf 'Diagnostic directory: %s\n' "$DIAGNOSTIC_DIR"
sed -n '1,240p' "$DIAGNOSTIC_DIR/manifest.json"
```

bundle은 OS temporary directory 아래 `manifest.json` 하나만 가집니다. `[Redacted]`가 필요한 곳에 있는지, 실제 token·prompt·transcript·회사명·사용자 절대 경로가 없는지 사람이 확인한 뒤에만 승인된 비공개 issue에 첨부합니다. raw log나 SQLite를 bundle에 덧붙이지 않습니다.

## reinstall과 uninstall

reinstall은 program checkout만 교체합니다. SQLite data, pilot config, Keychain은 program path 밖에 있으므로 그대로 보존합니다. 새 checkout에서 frozen install 후 setup을 실행할 때 blank credential prompt는 기존 Keychain account 이름을 보존합니다.

기본 uninstall 호출은 preview-only이고 program path와 exact confirmation 문구를 보여 준 뒤 exit 2로 끝납니다.

```bash
pnpm hq uninstall
```

출력된 program path가 정확한지 검토한 뒤, 출력된 complete re-run command를 그대로 사용합니다. 이 동작은 exact LaunchAgent와 program checkout을 제거하지만 Application Support data, config, Keychain을 보존합니다.

data까지 삭제하려면 별도 preview를 요청합니다.

```bash
pnpm hq uninstall --remove-data
```

`--remove-data` preview가 보여 준 program/data absolute path와 `REMOVE ORCA HQ PROGRAM AT ... AND DATA AT ...` 문구가 정확할 때만 출력된 confirm command를 실행합니다. 이 작업은 configured data와 그 안의 backup을 복구 불가능하게 삭제할 수 있습니다. 필요한 backup을 data directory 밖으로 옮기고 검증하기 전에는 실행하지 않습니다. Keychain credential과 별도 config는 uninstall이 읽거나 삭제하지 않으므로 필요하면 macOS Keychain Access와 파일 정책에 따라 사용자가 별도로 처리합니다.

관련 문서: [설치](../installation/private-pilot.md), [data handling](../security/data-handling.md), [threat model](../security/threat-model.md), [Security Policy](../../SECURITY.md).
