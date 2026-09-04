# Orca HQ private pilot

Orca HQ는 Slack, Telegram, Tailscale web에서 받은 작업을 한 대의 Mac에서 Orca의 Codex·Claude Code worker로 전달하고 검증하는 private pilot입니다. 현재 대상은 초대된 동료 3–5명뿐이며, **호스트 Mac이 켜져 있고 깨어 있고 네트워크에 연결된 동안에만 동작**합니다.

## 처음 시작하기

새 설치는 [20분 private pilot 설치 가이드](docs/installation/private-pilot.md)에서 시작하세요. 이 pilot의 설치 방식은 private Git 저장소를 `git clone`한 뒤 `pnpm install`과 `pnpm hq setup`을 실행하는 것뿐입니다. public npm 또는 Homebrew 패키지는 제공하지 않습니다.

## 문서

| 독자 | 문서 | 목적 |
| --- | --- | --- |
| 신규 동료 개발자 | [private pilot 설치](docs/installation/private-pilot.md) | 개인 계정 준비부터 `doctor`, 시작, 확인까지 |
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
node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/private-pilot-acceptance.json
```

위 acceptance report의 `evidenceMode`는 `deterministic_simulation`, `pilotReady`는 `false`입니다. 실제 동료 Mac에서의 설치·채널 연결·2주 운영 gate를 대신하지 않습니다.
