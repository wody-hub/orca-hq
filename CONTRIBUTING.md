# Orca HQ에 기여하기

이 public source repository는 초대된 동료만 운영하는 macOS pilot용입니다. 실제 Slack, Telegram, Tailscale, Keychain, Orca credential/config를 바꾸지 않고 synthetic fixture와 fake adapter로 개발합니다. 아직 license와 code of conduct가 없어 공개 열람 가능 상태가 사용·수정·재배포 허가나 일반 공개 contribution/support 접수를 뜻하지 않습니다.

## 개발 환경

- macOS, Node `>=22.20 <23`, Corepack, pnpm `9.15.5`
- public repository를 clone할 Git
- 실제 provider token이 없는 test 환경

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

## 변경 절차

1. issue에 문제, 사용자 영향, 범위, acceptance command를 적습니다. security 문제는 issue 대신 [Security Policy](SECURITY.md)를 사용합니다.
2. production change 전에 해당 break를 잡는 test를 작성하고 의도한 이유로 실패하는 RED를 확인합니다.
3. 통과에 필요한 최소 구현을 추가하고 focused test, 전체 test/typecheck/build를 실행합니다.
4. CLI command를 문서에 추가/변경하면 `packages/installer/test/documented-commands.test.ts`와 실제 `hq` usage를 함께 검토합니다.
5. 문서의 shell 예시는 copy/paste 가능한 synthetic command로 유지하고 README에서 두 번 이내 link로 도달하게 합니다.
6. 변경한 파일만 이름으로 stage합니다. `.artifacts/**`, 실제 Registry, credential, transcript, provider response, 사용자/회사 path는 commit하지 않습니다.

## Pull request 확인

```bash
pnpm test
pnpm typecheck
pnpm build
node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/private-pilot-acceptance.json
```

acceptance report는 deterministic simulation이며 live readiness 증거가 아닙니다. PR에는 test 결과, doctor의 exit code와 JSON 구조 확인, 변경된 security/data boundary, rollback 방법을 적습니다. 실제 credential이 필요한 검증을 CI나 contributor Mac에서 임의로 실행하지 않습니다.

## Bug issue 작성

일반 bug issue에는 다음만 포함합니다.

- 사용한 full commit SHA와 macOS/Node/Orca version
- 최소 synthetic reproduction과 expected/actual result
- 실패한 command의 exit code와 stable error text
- token/path/prompt/transcript를 제거한 diagnostic `manifest.json` 또는 audit reference
- active/uncertain Dispatch가 있었는지와 data 변경 여부

raw `gateway.log`, SQLite, `pilot.json`, project Registry, Keychain screenshot을 그대로 첨부하지 않습니다. redaction 여부가 불확실하면 먼저 private security report로 분류합니다.

## 설계 경계

- Codex HQ만 project 선택·Task 계획·최종 조정 권한을 가집니다. Claude Code가 자동 takeover하지 않습니다.
- model output은 제안이며 identity, policy, approval, lock, retry, verifier gate는 deterministic code가 소유합니다.
- L2/L3는 Slack/Tailscale digest-bound approval을 사용하며 Telegram approval을 추가하지 않습니다.
- secret은 Keychain/runtime-only, telemetry는 off, diagnostic은 explicit/local/redacted/reviewable입니다.
- update, reinstall, migration, backup, rollback, restart, uninstall은 durable state를 보존하거나 fail closed해야 합니다.

새 public distribution, Linux/Windows support, dashboard public exposure, provider OAuth install, telemetry opt-in은 현재 contribution 범위가 아닙니다.
