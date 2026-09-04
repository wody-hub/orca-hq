# 20분 안에 Orca HQ invitation-only pilot 설치하기

이 가이드를 끝내면 public source checkout에서 Orca HQ를 설치하고, non-secret 설정과 macOS Keychain credential을 구성하고, read-only `doctor`를 통과시킨 뒤 invitation-only 운영 pilot gateway를 시작할 수 있습니다. 20분 목표는 아래 외부 계정과 앱이 이미 준비되어 있다는 전제입니다.

## 준비물

- Apple Silicon 또는 Intel 기반 macOS Mac. Mac은 서비스 사용 중 켜져 있고 깨어 있고 네트워크에 연결되어 있어야 합니다.
- Git, Node `>=22.20 <23`, Corepack. repository를 읽고 clone하는 데 초대나 별도 권한은 필요하지 않습니다.
- 직접 설치하고 로그인한 Orca, Codex, Claude Code, Tailscale.
- 직접 만든 Slack App, 전용 Slack channel, Telegram bot과 허용할 chat ID, OpenAI API key.
- Orca에서 확인하고 승인한 정확히 5개의 pilot project.

공용 Mac이나 공유 OS 계정에는 설치하지 마세요. 실제 token, transcript, 고객명, 회사 전용 경로는 저장소 파일이나 issue에 쓰지 않습니다.

## 0. 외부 계정과 앱을 직접 준비하기

Orca HQ setup은 외부 계정을 대신 만들거나 권한을 변경하지 않습니다. 다음 작업을 각 provider의 공식 UI/CLI에서 먼저 마칩니다.

1. **Orca, Codex, Claude Code**: 각 도구를 설치하고 자신의 계정으로 인증합니다. `doctor`는 `orca --version`, `orca capabilities --format json`, `orca projects list --format json`, `codex login status`, `claude auth status`를 read-only로 확인합니다.
2. **Slack**: Slack의 새 App 생성 화면에서 [`templates/slack-app-manifest.yaml`](../../templates/slack-app-manifest.yaml)을 가져옵니다. Socket Mode를 사용하고 app token을 발급하며, App을 workspace에 설치하고 전용 channel에 초대합니다. setup에 넣을 app token과 channel ID를 준비합니다.
3. **Telegram**: BotFather에서 개인 pilot bot을 만들고 bot token을 받습니다. bot과 대화할 user/chat을 정한 뒤 allowlist에 쓸 chat ID를 준비합니다. Telegram은 L0/L1 요청만 가능하며 L2/L3 승인은 항상 거부됩니다.
4. **Tailscale**: 자신의 계정으로 승인된 tailnet에 Mac을 연결합니다. dashboard는 Tailscale Serve 전용이며 Funnel 또는 public bind를 사용하지 않습니다.
5. **OpenAI voice**: 자신의 OpenAI API key를 준비합니다. key는 setup 입력 직후 Keychain에 저장되고 repository나 pilot JSON에 기록되지 않습니다.

## 1. public source repository 설치하기

원하는 program directory의 상위 위치에서 실행합니다.

```bash
git clone https://github.com/wody-hub/orca-hq.git
cd orca-hq
git remote get-url origin
corepack enable
pnpm install --frozen-lockfile
```

`git remote get-url origin`의 출력은 다음과 같아야 합니다.

```text
https://github.com/wody-hub/orca-hq.git
```

다른 remote이거나 lockfile이 바뀌면 진행을 멈추고 repository owner에게 확인합니다. public npm 설치나 Homebrew 설치로 대체하지 마세요.

## 2. 5개 project Registry 준비하기

[`templates/projects.example.yaml`](../../templates/projects.example.yaml)은 schema를 보여 주는 synthetic 예시일 뿐입니다. `/srv/...`, `git.example.test`, 예시 alias를 그대로 쓰지 말고, Orca에서 확인한 자신의 절대 경로와 project ID로 별도 로컬 파일을 만드세요.

각 entry에는 최소한 다음 값을 검토합니다.

- `projectKey`, `orcaProjectId`, 실제 `absolutePath`, 필요하면 `canonicalRemote`와 `defaultBaseRef`
- 사람이 확인한 `aliases`, `component`, `instructionsFiles`, `sensitivePaths`
- `setupPolicy`, `allowedOperations`, 실행 가능한 `requiredChecks`, 충돌 단위인 `lockKey`

setup/doctor는 Registry의 project 수가 정확히 5인지 확인합니다. Registry는 repository 밖의 사용자 전용 경로에 두고 실제 회사 데이터가 든 파일은 commit하지 않습니다.

## 3. guided setup 실행하기

```bash
pnpm hq setup
```

순서대로 Registry의 절대 경로, Slack app token, Slack channel ID, Telegram bot token, Telegram allowlisted chat ID, OpenAI API key를 묻습니다. secret prompt는 터미널에 echo되지 않습니다.

setup은 먼저 필수 조건을 검사합니다. 통과하면 non-secret plan과 설정 대상만 보여 주고 `Apply this setup? [y/N]`에서 `y`를 입력한 뒤에만 다음을 수행합니다.

- 설정: `$XDG_CONFIG_HOME/orca-hq/pilot.json`(`XDG_CONFIG_HOME` 설정 시), 아니면 `~/.config/orca-hq/pilot.json`, mode `0600`
- 기본 SQLite: `~/Library/Application Support/orca-hq/control.sqlite`
- credential: macOS Keychain service `orca-hq`

설정에는 `schema`, `databasePath`, `projectRegistryPath`, Keychain `credentialAccounts`만 들어갑니다. 기존 설정을 migration할 때 credential 입력을 비워 두면 기존 account 이름을 보존하며 secret 값을 읽거나 다시 출력하지 않습니다.

## 4. read-only doctor 확인하기

```bash
pnpm hq doctor --format json
```

stdout은 `ok` boolean과 `checks` array가 있는 JSON 한 개뿐입니다. 각 check는 `id`, `status`(`pass`, `warn`, `fail`), `message`, 필요하면 `remediation`을 가집니다. 필수 check가 하나라도 `fail`이면 JSON을 출력한 뒤 exit 1로 끝나는 것이 정상입니다. exit 2와 `Usage: hq doctor --format json`은 argv 또는 flag 사용 오류입니다.

대표 remediation은 다음과 같습니다.

- `config.pilot-schema`: `pnpm hq setup`으로 설정 생성 또는 migration
- `registry.five-project-curation`: 승인한 project를 정확히 5개로 조정
- `orca.capabilities`, `codex.authentication`, `claude.authentication`: 해당 도구를 사용자가 직접 update/login
- `slack.socket-mode`, `telegram.allowlisted-chat`, `openai.voice`: setup을 다시 실행해 선택한 credential을 Keychain에 저장
- `tailscale.tailnet`: 사용자가 직접 승인된 tailnet 연결을 복구

## 5. gateway 시작하고 상태 확인하기

```bash
pnpm hq start
pnpm hq status
```

시작 성공 시 `Orca HQ gateway started.`를 출력합니다. status는 `{"state":"running","pid":...}` 또는 `{"state":"loaded"}` JSON을 출력합니다. `{"state":"stopped"}`는 exit 1이며, 이때 [운영 runbook](../operations/runbook.md)의 시작·log 절차를 따릅니다.

## 20분 완료 확인

- origin이 `https://github.com/wody-hub/orca-hq.git`이고 frozen install이 성공했습니다.
- pilot JSON에 secret 값이 없고 credential은 Keychain에 있습니다.
- `doctor` JSON의 `ok`가 `true`이고 필수 check가 `fail`이 아닙니다.
- `status`가 `running` 또는 `loaded`입니다.
- Slack/Telegram/Tailscale의 실제 연결 시험은 자신의 synthetic sandbox command로만 수행했고, Telegram에서 L2/L3 승인을 시도하지 않았습니다.

## 설치 문제 해결

- `Setup stopped before configuration; resolve failed checks with hq doctor.`: 출력된 JSON remediation을 처리합니다. 실패한 preflight는 설정과 Keychain을 변경하지 않습니다.
- `Setup cancelled; configuration unchanged.`: plan을 다시 검토한 뒤 setup을 재실행합니다.
- `Setup failed while applying configuration.`: secret은 재출력하지 말고 Keychain 권한과 설정 directory 권한을 확인합니다.
- `Gateway service operation failed.`: [운영 runbook](../operations/runbook.md#gateway가-시작되지-않음)의 exact LaunchAgent와 log 경로만 확인합니다.

다음 문서: [운영 runbook](../operations/runbook.md), [data handling](../security/data-handling.md), [threat model](../security/threat-model.md).
