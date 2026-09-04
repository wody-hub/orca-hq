# Orca HQ private pilot data handling

Orca HQ는 local-first pilot입니다. 외부 channel에서 들어온 work record와 운영 상태는 host Mac의 SQLite에 남을 수 있지만 credential은 macOS Keychain에 분리합니다. telemetry는 비활성이고 diagnostic은 자동 생성·전송되지 않습니다.

## 데이터 목록

| 데이터 | 위치 | 기본 보관/처리 | 공유·삭제 규칙 |
| --- | --- | --- | --- |
| Slack/Telegram/OpenAI credential | macOS Keychain service `orca-hq` | runtime에서 필요한 account만 조회 | config, log, backup, diagnostic, issue에 복사 금지. uninstall이 자동 삭제하지 않음 |
| Credential account 이름 | pilot JSON | credential lookup reference로 지속 보관 | secret이 아니지만 내부 구성 정보로 취급 |
| Pilot config | `$XDG_CONFIG_HOME/orca-hq/pilot.json` 또는 기본 `~/.config/orca-hq/pilot.json`, mode `0600` | schema, DB/Registry path, account 이름 | update backup에는 포함. 공개 issue 첨부 금지 |
| Project Registry | 사용자가 지정한 repository 밖 local path | 5개 project path, alias, policy, check | 회사 경로/remote/alias가 있으므로 Git commit과 공개 공유 금지 |
| Durable control state | 기본 `~/Library/Application Support/orca-hq/control.sqlite` | Command, proposal, approval, Run/Task/Dispatch, lock, cursor, Inbox/Outbox, audit | 기본 uninstall과 reinstall/update에서 보존. raw DB 공유 금지 |
| Command text와 voice provenance | SQLite Command payload | text는 durable work record, voice는 provider/hash/confidence metadata | prompt/transcript field는 log/diagnostic에서 redaction. retention 삭제는 운영 승인 후 수행 |
| Slack attachment bytes | OS temp 아래 managed staging directory | size 제한, SHA-256, 기본 15분 후 삭제; startup janitor가 만료 파일 정리 | provider URL과 temp path는 Command/audit에 저장하지 않음 |
| Voice audio bytes | OS temp의 `orca-hq-voice-*` | transcription 뒤 기본 즉시 삭제 | diagnostic caller가 명시적으로 retain한 경우만 남음; public CLI는 retain을 제공하지 않음 |
| Outbox payload/error | SQLite | delivery 완료 또는 bounded backoff retry 상태로 지속 | provider 오류는 safe code만 보관. delivery retry를 Task 재실행으로 해석 금지 |
| Gateway log | `~/Library/Logs/orca-hq/gateway.log`, `gateway.error.log` | repository가 자동 rotation/retention 기간을 정하지 않음 | operator가 local retention을 관리하고 공유 전 재검토 |
| Automatic update backup | `~/Library/Application Support/orca-hq/backups/<timestamp>/` | SQLite snapshot, 선택된 config, manifest; secret 없음 | data removal 전 외부 encrypted 위치로 옮기지 않으면 함께 삭제됨 |
| Local diagnostic | OS temp의 `orca-hq-diagnostics-*` | redacted `manifest.json` 한 개 | 사람이 검토한 뒤 승인된 private channel로만 공유; 자동 upload 없음 |
| Assignment artifact | user-owned private directory, mode `0700`; file `0600` | Dispatch owner/version/hash에 묶고 lifecycle cleanup | prompt/assignment에 secret 포함 금지; arbitrary path 사용 금지 |

경로의 `~`는 설명용입니다. 실제 lifecycle은 normalized absolute path를 사용하고 relative path, filesystem root, home directory, program/data overlap을 destructive target으로 거부합니다.

## Credential 흐름

1. 사용자가 provider별 계정과 token을 직접 준비합니다.
2. `pnpm hq setup`의 secret prompt는 echo를 mute합니다.
3. setup preflight와 non-secret plan을 통과하고 사용자가 `y`로 확인한 뒤에만 `security add-generic-password` boundary를 통해 Keychain에 저장합니다.
4. pilot JSON에는 값이 아닌 `slack-app-token`, `slack-channel-id`, `telegram-bot-token`, `telegram-allowed-chat-id`, `openai-api-key` account 이름만 기록합니다.
5. doctor는 `security find-generic-password`의 성공 여부만 사용하며 값을 stdout으로 읽거나 출력하지 않습니다.

provider 또는 Keychain 오류는 fixed CLI message로 바뀝니다. 오류 객체, argv, token을 log/issue에 복사하지 않습니다.

## Durable state와 restart

SQLite는 foreign key와 migration을 사용하며 gateway shutdown에서 transaction drain과 checkpoint를 시도합니다. startup은 Outbox claim과 channel cursor, nonterminal Dispatch, expired lock을 reconcile합니다. 이 때문에 다음 작업을 하지 않습니다.

- live SQLite 파일을 editor로 열어 row를 수정하거나 cursor/claim을 삭제
- `review_required` Dispatch를 receipt 확인 없이 terminal 상태로 강제 변경
- delivery 지연을 새 Task 실행으로 보상
- active/uncertain work가 있는 상태에서 update, backup restore, uninstall

backup/recovery 절차는 [운영 runbook](../operations/runbook.md)을 따릅니다.

## Log와 diagnostic redaction

구조화 logger는 대소문자를 무시해 `authorization`, `token`, `cookie`, `voiceUrl`, `signedUrl`, `prompt`, `transcript` key를 `[Redacted]`로 바꿉니다. path-like key는 basename만 남기거나 전체 redaction할 수 있고, operator는 회사명·고객명·private path·token 형식에 대한 `secretPatterns`를 추가해야 합니다.

redaction은 사람이 검토해야 하는 방어선이지 공유 허가가 아닙니다. 다음 순서로 처리합니다.

1. raw SQLite, config, Registry, Keychain export, provider payload를 diagnostic input에 넣지 않습니다.
2. `includeFullContent: false`, `pathDisclosure: "redact"`로 local bundle을 생성합니다.
3. `manifest.json`을 직접 열어 token, prompt, transcript, 회사명, 고객명, username, absolute path를 검색합니다.
4. 필요한 최소 safe status, aggregate counter, audit reference만 남깁니다.
5. [Security Policy](../../SECURITY.md)에 따른 private report에만 첨부합니다.

## Backup, reinstall, uninstall

- update backup은 SQLite online backup API를 사용하고 config를 포함하며 항상 `includesSecrets: false`입니다.
- automatic rollback은 prior program, database, config를 같은 receipt 기준으로 복구합니다. Keychain을 archive/restore하지 않습니다.
- reinstall은 program path만 교체하며 durable data/config/Keychain을 보존합니다.
- default uninstall은 exact service와 program만 제거하고 data를 보존합니다.
- `--remove-data`는 separate preview와 exact program+data phrase가 있어야 data directory를 삭제합니다. config와 Keychain은 별도 위치라 자동 삭제하지 않습니다.

현재 repository는 end-user retention 기간이나 selective row deletion CLI를 제공하지 않습니다. retention 변경 또는 data subject 요청은 임의 SQL로 처리하지 말고 repository owner와 security owner가 scope, backup, audit 필요성을 검토한 뒤 별도 change로 구현합니다.

## 외부 provider와 공유

Slack, Telegram, OpenAI transcription, Tailscale, Orca, Codex, Claude Code는 각 사용자의 별도 계정과 provider policy를 따릅니다. Orca HQ가 local audio를 삭제해도 provider가 이미 수신한 message/audio/API request의 보관을 대신 삭제하지는 못합니다. 실제 고객·회사 data를 pilot에 넣기 전에 각 provider의 승인된 workspace, retention, training/privacy 설정을 확인합니다.

관련 문서: [설치](../installation/private-pilot.md), [운영 runbook](../operations/runbook.md), [threat model](threat-model.md).
