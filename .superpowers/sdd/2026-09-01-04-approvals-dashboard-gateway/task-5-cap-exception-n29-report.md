# Task 5 상한 예외 수정 보고서 — N29 completion destination 계약

## 결론

Important N29만 수정했다. Slack 또는 tailscale-web 명령의 성공 검증이 `VerificationService.commitVerification` 전에 completion destination 해석 예외로 끊기지 않도록, 두 destination을 host/production의 필수 운영 설정으로 승격하고 외부 ingress나 SQLite 사용 전에 검증한다. 설정이 정상인 두 채널은 실제 production 상태 머신에서 `verified_success`, `verification.passed`, delivered Outbox까지 회귀한다.

## 원인 추적

기존 흐름은 다음 순서였다.

1. `VerificationService.complete`가 성공 결정을 계산한다.
2. `commitVerification` 호출 전에 production의 `completionTarget(report)`를 await한다.
3. Telegram은 durable command의 `externalMessageId`에서 chat ID를 복원한다.
4. Slack과 tailscale-web은 optional `completionDestinations`에서 대상을 조회한다.
5. 대상 또는 필드가 없으면 resolver가 예외를 던져 `commitVerification`에 도달하지 못한다.

따라서 검증 자체가 성공했어도 Run의 `verified_success` 전이, `verification.passed` audit, success Outbox가 한 트랜잭션도 남지 않았다. 실패 검증의 bounded Fix Task 경로는 completion target을 조회하지 않아 영향을 받지 않았고, 기존 E2E가 Telegram만 다뤄 결함이 드러나지 않았다.

## 구현 계약

- `GatewayHostSettings.completionDestinations`와 `GatewayProductionDependencies.completionDestinations`를 필수 객체로 바꿨다.
- 두 필드 `slack`, `tailscaleWeb`도 필수 non-empty string으로 고정해 정적 타입과 런타임 계약을 일치시켰다.
- host 경계는 strict Zod schema로 두 값을 trim·검증한다. 누락, 빈 문자열, 예상하지 않은 필드를 포함한 잘못된 설정은 redacted `Gateway configuration or secret provider is unavailable` 오류로 거부한다.
- 직접 `createProductionGateway`를 호출해 host를 우회하는 경우도 별도 런타임 guard가 두 값을 검증·정규화한다. 이 검사는 Gateway/lifecycle 생성 전에 실행되므로 SQLite 파일, secret validation, Orca, HTTP, Slack, Telegram ingress를 사용하지 않는다.
- completion resolver는 필수 설정을 사용한다. durable Run/Command 및 Telegram external ID에 대한 기존 방어 검사는 유지했다.

## TDD 증거

### RED 1 — host 경계

먼저 Slack과 tailscale-web destination을 각각 제거한 parameterized 회귀 테스트를 추가했다.

```text
pnpm vitest run apps/gateway/test/entry.test.ts -t "rejects a missing"

Test Files  1 failed (1)
Tests       2 failed | 3 skipped (5)
AssertionError: promise resolved ... instead of rejecting
```

기존 host가 두 불완전 설정을 모두 받아들여 production dependency graph를 반환하는 정확한 결함을 재현했다.

### RED 2 — host 우회 production 경계

production API에 partial destination 객체를 직접 넣는 두 회귀를 추가하고 production guard를 제거한 상태에서 실행했다.

```text
pnpm vitest run apps/gateway/test/production.test.ts -t "rejects a missing"

Test Files  1 failed (1)
Tests       2 failed | 6 skipped (8)
```

기존 `createProductionGateway`가 reject하지 않고 composition을 반환해 검증 시점까지 잘못된 계약을 지연시키는 것을 확인했다.

### GREEN — 대상 누락 및 정상 성공

```text
pnpm vitest run apps/gateway/test/production.test.ts -t "rejects a missing"
Test Files  1 passed (1), Tests 2 passed | 6 skipped

pnpm vitest run apps/gateway/test/entry.test.ts -t "rejects a missing"
Test Files  1 passed (1), Tests 2 passed | 3 skipped

pnpm vitest run apps/gateway/test/end-to-end.test.ts -t "configured destination"
Test Files  1 passed (1), Tests 2 passed | 3 skipped
```

정상 성공 회귀는 Slack과 tailscale-web 각각에 대해 다음 실제 경로를 실행한다.

`durable Command → production command flow → ExecutionService implement Dispatch → verifier Dispatch → VerificationService.complete → ControlStore.commitVerification → OutboxDispatcher.tick → channel provider`

각 채널에서 Run이 `verified_success`가 되고 `verification.passed` audit이 존재하며, Outbox가 설정된 destination과 channel/provider receipt를 가진 `delivered` 상태가 되는지 확인했다. 전달 payload의 literal text도 `검증 완료`로 확인했다.

## 최종 검증

```text
pnpm test
30 files passed, 515 tests passed

pnpm typecheck
exit 0

pnpm build
13 workspace projects exit 0

git diff --check -- <N29 변경 파일들>
exit 0
```

focused gateway suite 첫 실행에서 기존 dispatch action audit 두 건의 반환 순서 assertion이 한 번 역순으로 실패했으나, 해당 테스트 단독 재실행과 이후 전체 515-test suite는 통과했다. 이 관찰과 관련된 action audit 조회/정렬 변경은 N29 범위가 아니므로 적용하지 않았다.

## 자체 리뷰 및 범위 확인

- missing Slack/tailscale-web destination은 host 경계와 직접 production 경계에서 모두 DB 파일 생성 및 ingress 호출 전에 거부된다.
- 정상 Slack/tailscale-web 성공은 단순 resolver 단위 테스트가 아니라 durable 상태 전이, audit, Outbox와 provider 전달까지 검증한다.
- Telegram destination 복원 및 verification failure의 bounded Fix Task 계약은 변경하지 않았다.
- N30–N33, Outbox 주기 실행/scheduler, reconciliation, migration, action idempotency 코드는 수정하지 않았다.
- 실제 Slack/Telegram/Tailscale/Keychain/Orca 설정, credential, network를 생성하거나 변경하지 않았다.
- 사용자 소유 `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`를 읽기·수정·stage·restore하지 않았다.
- `apps/web/test-results/.last-run.json` 및 Playwright 산출물은 stage/commit하지 않는다.

## 변경 파일

- `apps/gateway/src/host.ts`
- `apps/gateway/src/production.ts`
- `apps/gateway/test/entry.test.ts`
- `apps/gateway/test/production.test.ts`
- `apps/gateway/test/end-to-end.test.ts`
- `.superpowers/sdd/2026-09-01-04-approvals-dashboard-gateway/task-5-cap-exception-n29-report.md`

원자적 커밋 메시지는 `fix(gateway): require verification destinations`로 기록한다.
