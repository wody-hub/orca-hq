# 20분 안에 Orca HQ invitation-only pilot 설치하기

이 가이드를 끝내면 public source checkout에서 Orca HQ를 설치하고, non-secret 설정과 macOS Keychain credential을 구성하고, read-only `doctor`를 통과시킨 뒤 invitation-only 운영 pilot gateway를 시작할 수 있습니다. 20분 목표는 아래 외부 계정과 앱이 이미 준비되어 있다는 전제입니다.

## 준비물

- Apple Silicon 또는 Intel 기반 macOS Mac. Mac은 서비스 사용 중 켜져 있고 깨어 있고 네트워크에 연결되어 있어야 합니다.
- Git, Node `>=22.20 <23`, Corepack. repository를 읽고 clone하는 데 초대나 별도 권한은 필요하지 않습니다.
- 직접 설치하고 로그인한 Orca, Codex, Claude Code, Tailscale.
- 직접 만든 Slack App, 전용 Slack channel, Telegram bot과 허용할 chat ID. OpenAI API key는 음성 전사를 사용할 때만 필요합니다.
- Orca에 등록된 프로젝트. HQ는 등록 목록을 자동으로 동기화합니다.

공용 Mac이나 공유 OS 계정에는 설치하지 마세요. 실제 token, transcript, 고객명, 회사 전용 경로는 저장소 파일이나 issue에 쓰지 않습니다.

## 0. 외부 계정과 앱을 직접 준비하기

Orca HQ setup은 외부 계정을 대신 만들거나 권한을 변경하지 않습니다. 다음 작업을 각 provider의 공식 UI/CLI에서 먼저 마칩니다.

1. **Orca, Codex, Claude Code**: 각 도구를 설치하고 자신의 계정으로 인증합니다. `doctor`는 `orca status --json`, `orca repo list --json`, `codex login status`, `claude auth status`를 read-only로 확인합니다.
2. **Slack**: Slack의 새 App 생성 화면에서 [`templates/slack-app-manifest.yaml`](../../templates/slack-app-manifest.yaml)을 가져옵니다. Socket Mode를 사용하고 app token을 발급하며, App을 workspace에 설치하고 전용 channel에 초대합니다. setup에 넣을 app token과 channel ID를 준비합니다.
3. **Telegram**: BotFather에서 개인 pilot bot을 만들고 bot token을 받습니다. bot과 대화할 user/chat을 정한 뒤 allowlist에 쓸 chat ID를 준비합니다. 내장 managed 모드는 지정한 개인 사용자만 프로젝트 관리와 개발 작업을 지시할 수 있습니다.
4. **Tailscale**: 자신의 계정으로 승인된 tailnet에 Mac을 연결합니다. dashboard는 Tailscale Serve 전용이며 Funnel 또는 public bind를 사용하지 않습니다.
5. **OpenAI voice (선택)**: 음성 전사를 사용할 때만 자신의 OpenAI API key를 준비합니다. 텍스트 지시는 기존 Codex CLI 인증을 사용하며 이 키를 요구하지 않습니다. key는 setup 최종 확인 후 Keychain에 저장되고 repository나 pilot JSON에 기록되지 않습니다.

## 1. public source repository 설치하기

원하는 program directory의 상위 위치에서 실행합니다.

```bash
git clone --branch dev --single-branch https://github.com/wody-hub/orca-hq.git
cd orca-hq
git remote get-url origin
git branch --show-current
corepack enable
pnpm install --frozen-lockfile
```

invitation-only pilot 동안 `git remote get-url origin`과 `git branch --show-current`의 출력은 각각 다음과 같아야 합니다.

```text
https://github.com/wody-hub/orca-hq.git
dev
```

다른 remote이거나 lockfile이 바뀌면 진행을 멈추고 repository owner에게 확인합니다. public npm 설치나 Homebrew 설치로 대체하지 마세요.

## 2. 기존 project Registry 및 자동 동기화

[`templates/projects.example.yaml`](../../templates/projects.example.yaml)은 schema를 보여 주는 synthetic 예시일 뿐입니다. `/srv/...`, `git.example.test`, 예시 alias를 그대로 쓰지 말고, Orca에서 확인한 자신의 절대 경로와 project ID로 별도 로컬 파일을 만드세요.

각 entry에는 최소한 다음 값을 검토합니다.

- `projectKey`, `orca repo list --json`이 반환한 repo `id`를 넣는 `orcaProjectId`, 실제 `absolutePath`, 필요하면 `canonicalRemote`와 `defaultBaseRef`
- 사람이 확인한 `aliases`, `component`, `instructionsFiles`, `sensitivePaths`
- `setupPolicy`, `allowedOperations`, 실행 가능한 `requiredChecks`, 충돌 단위인 `lockKey`

setup/doctor는 기존 Registry에 최소 1개 항목이 있는지 확인합니다. 이 파일은 기존 별칭·보호 경로 설정을 가져오는 용도이며, 실행 대상은 Orca 등록 목록에서 자동으로 발견합니다. 5개 제한은 없습니다. Registry는 repository 밖의 사용자 전용 경로에 두고 실제 회사 데이터가 든 파일은 commit하지 않습니다.

## 3. guided setup 실행하기

```bash
pnpm hq setup
```

순서대로 Registry의 절대 경로, Slack app token, Slack channel ID, Telegram bot token, Telegram allowlisted chat ID, OpenAI API key를 묻습니다. secret prompt는 터미널에 echo되지 않습니다. 새 설치에서 OpenAI 키를 비워 두면 `voiceMode: "disabled"`인 텍스트 전용 설정을 저장합니다. 키를 입력하면 `voiceMode: "openai"`를 저장합니다. 기존 설치에서 빈 입력은 기존 음성 모드를 유지하며, 모드 필드가 없는 이전 설정은 음성 키를 계속 요구합니다.

setup은 먼저 필수 조건을 검사합니다. 통과하면 non-secret plan과 설정 대상만 보여 주고 `Apply this setup? [y/N]`에서 `y`를 입력한 뒤에만 다음을 수행합니다.

- 설정: `$XDG_CONFIG_HOME/orca-hq/pilot.json`(`XDG_CONFIG_HOME` 설정 시), 아니면 `~/.config/orca-hq/pilot.json`, mode `0600`
- 기본 SQLite: `~/Library/Application Support/orca-hq/control.sqlite`
- credential: macOS Keychain service `orca-hq`

설정에는 `schema`, `databasePath`, `projectRegistryPath`, `voiceMode`, Keychain `credentialAccounts`만 들어갑니다. 기존 설정을 migration할 때 credential 입력을 비워 두면 기존 account 이름을 보존하며 secret 값을 읽거나 다시 출력하지 않습니다.

설치 직후 아래 read-only 명령으로 `orca-hq` service의 account 존재 여부만 확인합니다. `-w` 또는 `-g`를 사용하지 않고 명령 출력을 버리므로 credential 값은 읽거나 출력하지 않습니다.

```bash
for account in slack-app-token slack-channel-id telegram-bot-token telegram-allowed-chat-id openai-api-key; do
  if security find-generic-password -s orca-hq -a "$account" >/dev/null 2>&1; then
    printf '%s: present\n' "$account"
  else
    printf '%s: missing\n' "$account"
  fi
done
```

텍스트 전용 설정은 Slack·Telegram의 4개 account가 `present`이면 됩니다. 음성을 활성화했다면 `openai-api-key`까지 5개 모두 `present`여야 합니다. 필요한 account가 `missing`이면 credential 값을 출력하지 말고 setup을 다시 실행합니다.

## 4. read-only doctor 확인하기

```bash
pnpm hq doctor --format json
```

stdout은 `ok` boolean과 `checks` array가 있는 JSON 한 개뿐입니다. 각 check는 `id`, `status`(`pass`, `warn`, `fail`, `skip`), `message`, 필요하면 `remediation`을 가집니다. 명시적으로 꺼진 음성 검사는 `skip`으로 표시하며 음성 연결 성공을 뜻하지 않습니다. 필수 check가 하나라도 `fail`이면 JSON을 출력한 뒤 exit 1로 끝나는 것이 정상입니다. exit 2와 `Usage: hq doctor --format json`은 argv 또는 flag 사용 오류입니다.

대표 remediation은 다음과 같습니다.

- `config.pilot-schema`: `pnpm hq setup`으로 설정 생성 또는 migration
- `registry.projects-ready`: 기존 Registry와 Orca 등록 상태 확인 후 `pnpm hq projects sync`
- `orca.capabilities`, `codex.authentication`, `claude.authentication`: 해당 도구를 사용자가 직접 update/login
- `slack.socket-mode`, `telegram.allowlisted-chat`: setup을 다시 실행해 필요한 credential을 Keychain에 저장
- `openai.voice`: 음성을 켠 설정에서만 OpenAI 키가 필요합니다. `disabled`는 `skip`으로 보고됩니다.
- `tailscale.tailnet`: 사용자가 직접 승인된 tailnet 연결을 복구

## 프로젝트 관리 및 개발 작업 모드

외부 adapter를 별도로 지정하지 않은 설치는 내장 managed 모드를 사용합니다. 프로젝트 ID·경로는 Orca 등록 목록에서 읽고, 별칭과 HQ 사용 제외 설정은 `managed-projects.json`에 저장합니다. 기존 Registry의 민감 경로는 보존합니다.

Slack 앱에는 `groups:history`, `groups:read`, `chat:write`와 `message.groups` 이벤트가 필요합니다. 권한 변경 후 Reinstall to Workspace를 실행하고 비공개 채널에 봇을 초대합니다. `xapp-`는 Socket Mode, `xoxb-`는 응답 전송용입니다.

```bash
pnpm hq credential --account slack-bot-token
```

소유자 설정은 사용자 설정 디렉터리의 mode 0600 `managed-owner.json`에 `slackUserId`, `telegramUserId`를 기록합니다. 현재 개인 pilot은 비공개 채널의 유일한 사용자와 지정 Telegram 개인 ID를 연결했습니다. 다른 계정의 요청과 봇 메시지는 실행하지 않습니다. 새 설치에서는 이 소유자 연결까지 준비해야 합니다.

Slack은 지정 비공개 채널에서, Telegram은 봇과의 개인 대화에서 같은 문법을 사용합니다.

```text
프로젝트 목록
프로젝트 등록 /절대/저장소/경로
프로젝트 subway-seet 별칭 지하철
프로젝트 subway-seet 제외
프로젝트 subway-seet 복원
subway-seet 로그인 오류를 수정하고 관련 테스트를 실행해줘
subway-seet 진행 상황 알려줘
subway-seet 현재 작업 검토해줘
작업 목록
작업 <작업ID> 상태
작업 <작업ID> 중지
작업 <작업ID> 재시도
작업 <작업ID> 이어서 실패한 테스트도 수정해줘
```

터미널에서는 설치 디렉터리에서 실행합니다.

```bash
pnpm hq projects list
pnpm hq projects sync
pnpm hq projects activity subway-seet
pnpm hq projects review subway-seet
pnpm hq projects add /절대/저장소/경로
pnpm hq projects alias subway-seet 지하철
pnpm hq projects exclude subway-seet
pnpm hq projects restore subway-seet
pnpm hq run --project subway-seet --prompt '로그인 오류를 수정하고 관련 테스트를 실행해줘'
pnpm hq run --project subway-seet --worktree '<Orca작업공간ID>' --prompt '현재 변경 내용을 수정 없이 검토해줘'
pnpm hq jobs list
pnpm hq jobs show <작업ID>
pnpm hq jobs stop <작업ID>
pnpm hq jobs retry <작업ID>
pnpm hq jobs followup <작업ID> '실패한 테스트도 수정해줘'
pnpm hq ask '프로젝트 목록'
```

세 입력 경로는 같은 Orca 작업 ID를 사용합니다. Orca에서 직접 시작한 작업은 `projects activity`로 작업 공간·터미널 상태를 확인합니다. `projects review`는 검토 가능한 작업 공간 ID를 안내하며, 실제 검토 지시는 `run --worktree`로 정확한 대상을 선택해 Orca에 전달합니다. 진행률은 임의의 퍼센트로 추정하지 않습니다. Slack 응답은 원래 메시지 스레드, Telegram 응답은 원래 개인 대화에 전달합니다. 터미널은 사용자만 접근 가능한 Unix socket을 사용하고, 실행 결과는 `jobs show`로 조회합니다. 프로젝트 제외는 디스크 파일 삭제나 Orca 등록 해제가 아닙니다.

HQ는 Orca 오케스트레이션의 중간 채널입니다. 실제 작업과 상태는 Orca의 Run/Task/Dispatch/Worker가 관리하며, HQ는 공식 명령으로 지시와 결과를 중계합니다. HQ 자체 Codex 실행기나 별도 작업 스케줄러는 사용하지 않습니다. 새로운 작업은 Orca가 작업 공간과 로그인된 에이전트를 시작하며 프로젝트의 setup 정책을 따릅니다. HQ 재시작은 Orca 작업을 임의로 중단하지 않습니다. 결과 불명 상태는 자동으로 재실행하지 않습니다. 보호 roadmap이 있는 HQ 자체 프로젝트는 보호 규칙 때문에 실행이 제한됩니다. 음성은 이번 managed 모드에서 지원하지 않습니다.

`127.0.0.1:4310/health`에는 프로세스와 채널 연결 상태만 표시합니다. 한 채널이 재연결 중이어도 다른 채널과 터미널은 사용 가능합니다. 외부 공개 bind 및 Funnel은 사용하지 않습니다.

## 5. gateway 시작하고 상태 확인하기

```bash
pnpm hq start
pnpm hq status
```

시작 명령은 launchd PID 생성과 해당 PID의 `/health` 서비스 준비 상태를 확인한 뒤 `Orca HQ gateway started.`를 출력합니다. 준비 확인이 실패하면 nonzero로 종료하고 새로 시작한 실패 서비스를 중지합니다. status는 `{"state":"running","pid":...}` 또는 `{"state":"loaded"}` JSON을 출력합니다. `loaded`는 실제 연결 성공을 의미하지 않습니다. `{"state":"stopped"}`는 exit 1이며, 이때 [운영 runbook](../operations/runbook.md)의 시작·log 절차를 따릅니다.

## 20분 완료 확인

- origin이 `https://github.com/wody-hub/orca-hq.git`이고 branch가 `dev`이며 frozen install이 성공했습니다.
- pilot JSON에 secret 값이 없고 credential은 Keychain에 있습니다.
- `doctor` JSON의 `ok`가 `true`이고 필수 check가 `fail`이 아닙니다.
- `status`가 `running`이고 `/health`의 PID가 일치합니다.
- Slack·Telegram·터미널에서 별도 시험 저장소의 실제 수정/테스트 작업과 사용자 응답 수신까지 확인했습니다.

## 설치 문제 해결

- `Setup stopped before configuration; resolve failed checks with hq doctor.`: 출력된 JSON remediation을 처리합니다. 실패한 preflight는 설정과 Keychain을 변경하지 않습니다.
- `Setup cancelled; configuration unchanged.`: plan을 다시 검토한 뒤 setup을 재실행합니다.
- `Setup failed while applying configuration.`: secret은 재출력하지 말고 Keychain 권한과 설정 directory 권한을 확인합니다.
- `Gateway service operation failed.`: [운영 runbook](../operations/runbook.md#gateway가-시작되지-않음)의 exact LaunchAgent와 log 경로만 확인합니다.

다음 문서: [운영 runbook](../operations/runbook.md), [data handling](../security/data-handling.md), [threat model](../security/threat-model.md).

외부 모듈 경로는 유지하지만, 기존 외부 모듈이 로컬 모드의 `/health` 계약을 구현하지 않으면 현재 `hq start` 준비 확인을 통과하지 못합니다.

## 프로젝트명을 몰라도 대화로 작업하기

Slack 비공개 채널의 같은 스레드, Telegram 봇의 같은 개인 대화, 터미널 대화 세션에서 프로젝트 선택을 이어갈 수 있습니다. 이름을 외우지 말고 `지하철 앱 로그인 문제 좀 봐줘`처럼 설명하세요. AI가 등록된 이름·별칭·경로와 대화 맥락을 보고 후보를 제시합니다. `1번` 또는 `모바일 쪽`처럼 답하면 됩니다. 애매한 후보를 선택하기 전에는 코드 작업을 시작하지 않습니다.

`기존 프로젝트가 어디 있는지 찾아보자`라고 말하면 위치 단서를 물어봅니다. 프로젝트들이 있는 상위 폴더의 절대 경로를 알려주면 그 범위에서 기존 Git 프로젝트를 찾고, 등록할 정확한 경로를 확인합니다. 폴더 검색은 깊이·개수·시간이 제한되므로 못 찾았다는 응답이 컴퓨터 전체에 없다는 뜻은 아닙니다. 숨김 폴더·비밀 경로·심볼릭 링크는 탐색하지 않습니다. macOS `/tmp` 같은 링크 경로 대신 실제 경로를 사용하세요.

`새 가계부 앱을 만들고 싶어`처럼 시작해 목적과 이름, 생성 위치를 함께 정할 수도 있습니다. 최종 경로를 확인한 뒤 새 폴더와 Git 저장소, Orca 작업 공간 사용에 필요한 초기 빈 커밋을 만들고 Orca에 등록합니다. 기존 폴더는 덮어쓰지 않습니다. 등록 후 `기본 화면과 테스트를 만들어줘`처럼 실제 개발을 지시하면 Orca 오케스트레이션에 전달됩니다.

터미널에서 설치본 폴더로 이동한 뒤 대화를 시작합니다.

```sh
cd ~/Applications/orca-hq
pnpm hq chat
```

화면에 표시된 세션 ID로 같은 대화를 다시 열 수 있습니다. 단발 명령도 같은 세션을 사용하면 맥락을 이어갑니다.

```sh
pnpm hq chat --session my-work
pnpm hq ask --session my-work '지하철 앱 작업하고 싶어'
pnpm hq ask --session my-work '1번'
pnpm hq ask --session my-work '현재 진행 상황 알려줘'
```

`/new`는 새 대화, `/exit` 또는 입력 종료(EOF)는 터미널 대화 종료입니다. `취소`는 대기 중 선택을 초기화합니다. 대화를 초기화해도 이미 실행 중인 Orca 작업을 중지하지는 않습니다. 작업 중지는 별도 작업 명령으로 지시하세요. 서로 다른 채널·스레드·터미널 세션의 선택은 자동으로 합치지 않습니다.

AI 의도 해석에는 기존 Codex 로그인 인증을 사용합니다. 해석기는 파일 작업을 직접 하지 않으며 확인된 지시는 기존 Orca native 실행 경로로 전달됩니다. AI 응답을 얻지 못하면 작업을 시작하지 않고 다시 설명하도록 안내합니다.

## 전역 hq 명령 자동 등록

일반 사용자 설치에서는 `pnpm install --frozen-lockfile`의 prepare 단계가 `~/.local/bin/hq`를 기본 등록합니다. 이 명령은 설치할 때 사용한 Node와 해당 설치본 CLI를 직접 실행하므로, 다른 프로젝트 폴더에서 Corepack이나 pnpm 버전에 영향을 받지 않습니다. zsh의 `.zprofile`·`.zshrc`(ZDOTDIR 설정 시 해당 디렉터리), bash의 `.bash_profile`·`.bashrc`에는 중복 없는 PATH 설정을 추가합니다. 기존 터미널에 해당 PATH가 없었다면 새 터미널을 열어주세요.

이후 어느 폴더에서든 다음처럼 실행합니다.

```sh
hq chat
hq ask --session my-work '프로젝트를 함께 찾아보자'
hq doctor --format json
```

이미 다른 프로그램이나 다른 HQ 설치본의 `hq`가 있으면 덮어쓰지 않고 기존 명령을 유지한다는 안내를 출력합니다. CI에서는 등록하지 않습니다. 개발용 의존성 설치처럼 전역 등록이 불필요하면 `ORCA_HQ_SKIP_GLOBAL_CLI=1 pnpm install --frozen-lockfile`로 생략할 수 있습니다. 기존 설치본에 전역 명령만 등록하려면 설치 폴더에서 `node packages/installer/bin/install-global.js`를 실행합니다. 계정·자격증명 setup을 다시 할 필요는 없습니다.
