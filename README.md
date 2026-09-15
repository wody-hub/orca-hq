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

지시를 접수하면 다음 입력을 바로 받을 수 있습니다. `hq chat`이 여는 것은 **관찰용 뷰어 창**(`--progress-window=auto`를 명시할 때만)일 뿐이며, 실제 작업은 HQ 서버가 소유한 별도의 **Orca 네이티브 터미널**에서 codex/claude worker로 실행됩니다. `--progress-window`를 지정하지 않거나 `off`로 주면 뷰어 창은 열리지 않지만, 네이티브 실행 자체는 이 값과 무관하게 항상 그대로 진행됩니다. 개발·분석·검토를 요청해 업무 맥락이 배정되면 `hq watch --context <맥락-ID>`로 확인할 수 있는 안내가 출력됩니다.

전체 작업 목록 조회, 인사, 도움말은 새 업무를 만들지 않고 HQ 입력창에 답합니다. 따라서 “지금 돌아가고 있는 작업 목록 보여줘”에는 별도 네이티브 worker가 실행되지 않습니다.

**동시 실행 worker 수**는 설치된 설정 파일의 `nativeExecution.maxActiveWorkers`(생략 시 기본값 **10**, 운영자 override로 `HQ_MAX_ACTIVE_WORKERS` 환경변수 사용 가능, `"unlimited"` 허용)로 정해집니다. 이 한도를 넘는 요청은 순서대로 대기합니다. 같은 프로젝트 checkout을 수정하는 등 자원 충돌이 있으면 슬롯이 남아 있어도 대기할 수 있습니다.

**터미널을 닫는 것과 대화를 닫는 것은 서로 다릅니다.** `hq chat`을 `/exit`로 나가거나 관찰용 `hq watch`/진행 창을 닫아도 네이티브 worker는 계속 실행됩니다 — 이들은 진행 상황을 보는 뷰어일 뿐 실행 주체가 아닙니다. worker를 실제로 멈추려면 `/hq {"action":"stop"}` 같은 제어 명령으로 명시적으로 중지해야 합니다. 완료된 "primary" 작업의 터미널은 기본적으로 **재사용을 위해 유지(retain)**되며(idle 상태로 남아 다음 같은 프로젝트 작업에서 재사용), 설정의 `nativeExecution.retentionPolicy`를 `"release"`로 바꾸면 완료 즉시 반환됩니다.

**Orca 터미널을 찾으려면** `hq chat`이 출력하는 `hq watch --context <맥락-ID>` 안내를 그대로 실행하거나, `--progress-window=auto`로 실행해 macOS Terminal 창이 자동으로 열리게 하세요. HQ는 어떤 경우에도 기존 desktop 창의 포커스를 가로채지 않습니다.

**서로 다른 provider(codex/claude)로 등록된 role profile 중 하나가 실패**하면(예: 자격 증명 만료, 모델 거부) 해당 worker의 이벤트는 `hq chat`/`hq watch`에 있는 그대로 표시되며 — 존재하지 않는 handle이나 모델명을 대신 지어내지 않고, 확인이 필요한 상태로 명시적으로 표시됩니다 — 다른 profile로 실행 중인 worker에는 영향을 주지 않습니다.

`/context <맥락-ID>`로 후속 지시의 대상을 지정하고, `/request <요청-ID>`로 접수 상태를 조회합니다. `/new`는 새 대화를 시작하고 `/exit`는 입력창에서 나갑니다. Slack·Telegram 지시는 자동 터미널 창을 열지 않습니다.

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
