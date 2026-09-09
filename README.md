# Orca HQ public source, invitation-only pilot

Orca HQ는 Slack, Telegram, Tailscale web에서 받은 작업을 한 대의 Mac에서 Orca의 Codex·Claude Code worker로 전달하고 검증합니다. source repository는 공개되어 있지만 현재 운영 pilot과 지원은 초대된 동료 3–5명만 대상으로 하며, **호스트 Mac이 켜져 있고 깨어 있고 네트워크에 연결된 동안에만 동작**합니다.

## 처음 시작하기

새 설치는 [20분 invitation-only pilot 설치 가이드](docs/installation/private-pilot.md)에서 시작하세요. 공개 Git repository를 `git clone`한 뒤 `pnpm install`과 `pnpm hq setup`을 실행합니다. public npm 또는 Homebrew package와 production/general-availability support는 제공하지 않습니다. repository에는 아직 license가 없으므로 공개 열람 가능 상태를 open-source 사용·수정·재배포 허가로 해석하지 마세요.

## 터미널에서 업무 지시하기

```bash
hq chat
# 기존 대화 재개
hq chat --session <세션-ID>
# 자동 진행 창 없이 사용
hq chat --progress-window=off
# 특정 업무의 진행 상황 다시 보기
hq watch --context <맥락-ID>
```

지시를 접수하면 다음 입력을 바로 받을 수 있습니다. 대화형 macOS 터미널에서는 새 업무마다 별도 Terminal 진행 창을 열고, 같은 업무의 후속 지시는 기존 맥락과 살아 있는 창을 재사용합니다. 독립 업무는 최대 **5개**까지 동시에 실행하며 여섯 번째부터 순서대로 대기합니다. 같은 작업 폴더를 수정하는 등 자원 충돌이 있으면 실행 슬롯이 남아 있어도 대기할 수 있습니다.

전체 작업 목록 조회, 인사, 도움말은 새 업무를 만들지 않고 HQ 입력창에 답합니다. 따라서 “지금 돌아가고 있는 작업 목록 보여줘”에는 별도 진행 창이 열리지 않습니다. 개발·분석·검토를 요청해 업무 맥락이 배정되면 진행 창이 열립니다.

`/context <맥락-ID>`로 후속 지시의 대상을 지정하고, `/request <요청-ID>`로 접수 상태를 조회합니다. `/new`는 새 대화를 시작하고 `/exit`는 입력창에서 나갑니다. 진행 창의 Ctrl+C나 대화 종료는 실행 중인 업무를 취소하지 않습니다. 창이 열리지 않으면 표시된 `hq watch` 명령으로 관찰할 수 있습니다. Slack·Telegram 지시는 자동 터미널 창을 열지 않습니다.

## 문서

| 독자 | 문서 | 목적 |
| --- | --- | --- |
| 초대된 pilot 동료 | [invitation-only pilot 설치](docs/installation/private-pilot.md) | 개인 계정 준비부터 `doctor`, 시작, 확인까지 |
| 운영자 | [운영 runbook](docs/operations/runbook.md) | 장애, 재시작, backup, update, rollback, uninstall |
| 보안 검토자 | [threat model](docs/security/threat-model.md) | 신뢰 경계, 위협, 통제, 잔여 위험 |
| 사용자·운영자 | [data handling](docs/security/data-handling.md) | credential, SQLite, log, 첨부물, 진단 자료의 처리 |
| 신고자 | [Security Policy](SECURITY.md) | 취약점 비공개 신고와 대응 범위 |
| 기여자 | [Contributing](CONTRIBUTING.md) | 개발, test, 문서, issue 작성 규칙 |

## 반드시 지킬 경계

- Orca, Codex, Claude Code, Slack App, Telegram bot, OpenAI voice credential, Tailscale 계정은 사용자마다 직접 준비합니다.
- setup이 받는 Slack·Telegram·OpenAI credential 값은 macOS Keychain의 `orca-hq` service에 저장합니다. Orca·Codex·Claude Code·Tailscale 인증은 각 도구가 관리하며 HQ 설정에 복사하지 않습니다.
- `pnpm hq doctor --format json`은 read-only 검사입니다. 필수 조건이 실패하면 parse 가능한 JSON을 출력하고 exit 1로 끝납니다.
- L2/L3 승인은 Slack 또는 Tailscale에서만 가능하고 15분 뒤 만료됩니다. Telegram은 L2/L3를 승인할 수 없습니다.
- telemetry는 비활성입니다. 진단 자료는 사용자가 명시적으로 로컬에서 만들고, redaction 결과를 직접 검토한 뒤에만 공유합니다.
- 기본 uninstall은 program만 대상으로 하고 durable data를 보존합니다. data 삭제에는 별도 `--remove-data`와 경로별 정확한 확인 문구가 필요합니다.

## 저장소 검증

외부 계정이나 실제 provider에 연결하지 않고 synthetic fixture만 사용합니다.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
PILOT_REPORT_DIR=$(mktemp -d)
node scripts/run-pilot-acceptance.mjs --runs 20 --output "$PILOT_REPORT_DIR/private-pilot-acceptance.json"
```

위 acceptance report의 `evidenceMode`는 `deterministic_simulation`, `pilotReady`는 `false`입니다. 실제 동료 Mac에서의 설치·채널 연결·2주 운영 gate를 대신하지 않습니다.
