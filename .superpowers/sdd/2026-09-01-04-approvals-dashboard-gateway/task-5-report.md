# Task 5 보고서 — Gateway lifecycle 및 end-to-end 상태 머신

## 구현 내용

- `apps/gateway/src/config.ts`에서 비밀 값 자체를 프로세스 설정으로 복사하지 않는 최소 Gateway 설정 검증 경계를 추가했다. Keychain 접근과 secret 검증은 주입되는 `GatewayConfigPort.validate`에서 수행하므로 테스트 fake와 실제 Keychain 구현이 분리된다.
- `apps/gateway/src/lifecycle.ts`에 주입 가능한 `Gateway` composition root를 추가했다. 시작 순서는 `config.valid → db.migrated → orca.checked → reconciled → http.started → slack.started → telegram.started`이며, config/migration/Orca/reconciliation 실패는 외부 ingress 전에 fail-closed 한다.
- Slack 또는 Telegram 시작 오류는 credential/provider 원문 없이 `channel_start_failed` 진단으로만 남기고 다른 ingress를 살리는 degraded start로 처리한다. 종료는 Telegram/Slack/HTTP ingress를 먼저 중지하고 bounded local-transaction drain, DB checkpoint, close를 수행하며 Orca stop/release 호출을 하지 않는다.
- `Gateway.acceptCommand`는 이미 구축된 durable command/HQ/policy/execution 상태 머신을 `GatewayCommandFlowPort`로 호출하고, delivery가 있으면 별도 delivery 포트로 넘긴다. Gateway는 기존 ExecutionService·approval·Outbox의 도메인 상태 전이를 중복 구현하지 않는다.
- `apps/gateway/src/main.ts`에는 테스트 가능한 lifecycle과 분리된 SIGINT/SIGTERM wiring을 추가했다.
- `apps/gateway/src/http.ts`는 주입된 prebuilt asset 포트로 정적 asset과 extension-less SPA deep link를 제공한다. `/api/*`, `/auth/*`, 누락 파일은 fallback 대상이 아니며 404를 유지한다.
- `vitest.config.ts`의 web include를 `apps/web/src/**/*.test.{ts,tsx}`로 확장하여 `api.test.ts`를 루트 테스트에 포함했다.

## TDD 증거

### RED

```text
pnpm test apps/gateway/test/lifecycle.test.ts apps/gateway/test/end-to-end.test.ts
FAIL Cannot find module '../src/lifecycle.js'
```

이는 composition root가 없어서 발생한 의도된 RED였다.

```text
pnpm test apps/gateway/test/http-auth.test.ts
FAIL expected 404 to be 200
```

이는 static asset/SPA fallback이 없어서 발생한 의도된 RED였다.

```text
pnpm test apps/gateway/test/lifecycle.test.ts
FAIL expected [..., 'db.closed'] but received no db.closed
```

이는 Orca 호환성 실패 뒤 durable DB close가 빠진 것을 잡은 RED였고, 이후 시작 실패 cleanup을 추가했다.

### GREEN

```text
pnpm test apps/gateway/test/lifecycle.test.ts apps/gateway/test/end-to-end.test.ts apps/gateway/test/http-auth.test.ts
3 files passed, 14 tests passed
```

새 lifecycle 테스트는 정상 시작 순서, degraded channel, incompatible Orca fail-closed/DB close, ingress→verified delivery 조립, 종료 drain/checkpoint 순서를 검증한다. HTTP 테스트는 asset, SPA deep link, API/auth 404 경계를 검증한다.

## 시작·종료·장애 모드

| 모드 | 결과 |
| --- | --- |
| 정상 시작 | migration·Orca 검사·reconciliation 뒤 HTTP와 채널 ingress를 순서대로 시작 |
| config/migration/Keychain/Orca 실패 | HTTP/Slack/Telegram 시작 전 실패, 이미 연 DB는 close |
| 단일 채널 시작 실패 | 다른 채널과 HTTP를 계속 제공, redacted `channel_start_failed`만 진단 |
| 종료 | 새 ingress 중지 → bounded local claim drain → WAL checkpoint/DB close; Orca 상태 보존 |

## 전체 검증 결과

```text
pnpm test
27 files passed, 487 tests passed

pnpm typecheck
exit 0

pnpm build
exit 0 (13 workspace projects)

pnpm --filter @orca-hq/web test:e2e
4 passed
```

Playwright 실행에서는 `NO_COLOR`/`FORCE_COLOR` 관련 Node 경고만 있었으며, 테스트 실패는 없었다.

## 변경 파일

- `apps/gateway/src/config.ts`
- `apps/gateway/src/lifecycle.ts`
- `apps/gateway/src/main.ts`
- `apps/gateway/src/http.ts`
- `apps/gateway/test/lifecycle.test.ts`
- `apps/gateway/test/end-to-end.test.ts`
- `apps/gateway/test/http-auth.test.ts`
- `vitest.config.ts`

## Self-review

- API/auth catch-all이 SPA로 응답하지 않는지 테스트했다.
- 외부 provider 오류 원문을 status/diagnostics로 전파하지 않는지 확인했다.
- shutdown이 active Orca Task/Dispatch/worktree를 stop/release하지 않는지 확인했다.
- 사용자 소유 `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`는 변경 상태를 유지하되 읽기·수정·stage하지 않았다.

## 우려사항 및 후속 범위

- 구성 경계는 실제 Keychain/Slack/Telegram/Orca credential을 의도적으로 생성하거나 변경하지 않는다. production bootstrap은 각 typed adapter를 `RuntimeAdapters`에 주입해야 한다.
- Gateway는 기존 durable approval/Execution/Outbox 상태 머신을 호출하는 composition 경계이며, 별도의 상태 머신을 만들지 않는다. L0–L3 policy 및 verification 실패 차단은 기존 core/worker-routing 테스트에 의해 검증되며 이번 fake E2E는 brief의 L1 verified-delivery 조립을 검증한다.
- 구현 커밋은 `dec9129 feat(gateway): compose Orca HQ lifecycle`이다. 사용자 소유 roadmap과 ignored 보고서는 커밋에 포함하지 않았다.
- `git diff --check e3c9ac7c4fb243319159bfb7f33a6b819c869bf2..HEAD`는 exit 0으로 완료했다.

## 수정 1차

### 변경 요약

- `apps/gateway/src/production.ts`와 `entry.ts`에 `openDatabase`/`ControlStore`/`OrcaClient`/`WorktreeLockService`/`ExecutionLifecycle`/`ExecutionService`/`OutboxDispatcher`를 한 번씩 조립하는 production composition과 local typed host bootstrap 진입점을 추가했다. secret·Slack·Telegram·Tailscale 핸들은 host가 주입하며, bootstrap module·secret port가 없으면 fail-closed 한다.
- lifecycle은 start/stop promise latch와 stop-request 경계를 사용해 시작 도중 종료가 오면 뒤쪽 ingress를 열지 않고, checkpoint/close가 한 번만 실행되게 했다. lifecycle 상태는 `ControlStore.appendAudit`으로 redacted durable event를 기록한다.
- dashboard wire shape를 `id` 기준으로 통일하고, detail evidence 및 task `canStop`/`canRetry`, `passed | pending | failed` verification contract를 서버·웹에 동시에 고정했다. SPA fallback은 decode·소문자 분류로 API/auth encoded/case 우회를 JSON 오류로 막는다.

### RED/GREEN

- RED: delayed migration 중 `stop()`을 호출하는 lifecycle test는 기존 코드에서 startup이 `running`으로 되살아나는 문제를 재현했다. concurrent/post-failure stop test는 checkpoint/close 중복을 재현했고, `/api%2Fmissing` 등은 SPA HTML 200을 재현했다.
- GREEN: `pnpm test apps/gateway/test/lifecycle.test.ts apps/gateway/test/http-auth.test.ts apps/gateway/test/api.test.ts`는 29 tests passed였고, `apps/gateway/test/end-to-end.test.ts`는 실제 Telegram normalization·ControlStore·policy/approval digest 경계 2 tests passed였다.

### 전체 검증

```text
pnpm test                                      27 files, 491 tests passed
pnpm typecheck                                 exit 0
pnpm build                                     exit 0
pnpm --filter @orca-hq/web test:e2e            4 passed
git diff --check                               exit 0
```

### Self-review: 차단 항목 대응

| Finding | 대응 파일·검증 |
| --- | --- |
| C1 | `production.ts`, `entry.ts`, `package.json`: concrete durable/Orca/execution/outbox 조립 및 host bootstrap start path 추가 |
| C2 | `lifecycle.ts`; `cancels an in-flight startup...` |
| C3 | `end-to-end.test.ts`: 실제 Telegram normalization, ControlStore audit, L1/L2/L3 policy와 exact digest/phrase 경계 검증으로 fake literal assertion 제거 |
| I1 | `routes/commands.ts`, `api.ts`, `api.test.ts`: unified `id` summary/detail wire shape |
| I2 | 같은 wire contract와 `command-detail.tsx`; task별 제어 가능 여부를 UI disabled state에 반영 |
| I3 | `lifecycle.ts`; `shares one shutdown latch...` |
| I4 | `http.ts`, `http-auth.test.ts`: encoded/case/malformed protected path regressions |
| I5 | `tsconfig.json`: `apps/*/test/**/*.ts`를 root typecheck에 포함하고 optional delivery를 narrow |
| I6 | `lifecycle.ts`, `lifecycle.test.ts`: process recreation 뒤 durable redacted lifecycle audit 조회 |

### 변경 파일·커밋·남은 우려

- 변경 파일: `apps/gateway/{package.json,src/{entry,production,http,lifecycle,routes/commands}.ts,test/{api,end-to-end,http-auth,lifecycle}.test.ts}`, `apps/web/{src/{api,app.test,routes/command-detail}.tsx,e2e/mobile-dashboard.spec.ts}`, `tsconfig.json`, `pnpm-lock.yaml`.
- 커밋은 이 수정 절 작성 뒤 의도된 파일만 stage하여 생성한다. 사용자 소유 roadmap은 읽거나 stage하지 않았다.
- 남은 우려: production host module은 deployment 환경이 typed external clients와 Keychain secret port를 제공해야 하며, 이 저장소의 테스트는 실제 credential 또는 provider connection을 생성하지 않는다.

## 수정 2차

### 구현 및 데이터 흐름

- `production.ts`는 DB open/migration을 lifecycle의 `config.validate` 뒤로 지연했다. 따라서 config 또는 Keychain secret 검증 거부 시 SQLite handle/file과 ingress가 생기지 않으며, 시작 뒤에는 concrete `openDatabase`/`ControlStore`/lock/execution/outbox 조립을 한 번만 수행한다.
- `dashboard.ts`의 `createCommandDashboard`는 `ControlStore`의 command/run/task/dispatch/audit/outbox durable record에서 목록·상세를 계산한다. run/task/dispatch가 없거나 terminal이 아닌 경우는 `pending`과 빈 evidence를 사용하며, dispatch 상태표가 `canStop`/`canRetry`를 서버에서 계산한다.
- lifecycle 취소 cleanup의 소유자를 stop path로 통일해, HTTP 또는 Slack/Telegram 시작 경계에서 취소되어도 ingress stop → transaction drain → WAL checkpoint → DB close를 보장했다. entry는 host module 부재를 노출하지 않고 redacted config/secret 오류로 fail-closed 한다.

### TDD RED/GREEN

- RED: `stops ... ingress before drain and durable close ...` parameterized lifecycle test는 기존 코드에서 `db.closed`가 `http.stopped`/drain보다 먼저 나오는 것을 재현했다.
- GREEN: `pnpm vitest run apps/gateway/test/lifecycle.test.ts`는 10 tests passed로 HTTP/Slack/Telegram 세 시작 경계와 기존 migration 취소를 통과했다.
- RED: `dashboard.test.ts`는 없는 production dashboard module로 실패했고, 실제 store query adapter를 추가한 뒤 `pnpm vitest run apps/gateway/test/dashboard.test.ts`가 1 test passed가 되었다.

### Self-review: 7개 finding 대응

| Finding | 구현 위치 | 회귀/동작 테스트 |
| --- | --- | --- |
| C1 | `apps/gateway/src/production.ts`, `entry.ts` | `production.test.ts`의 config 후 concrete DB 조립·ingress 시작, `entry.test.ts` fail-closed |
| C3 | `apps/gateway/test/end-to-end.test.ts` | `takes normalized Telegram command 501 through Gateway acceptance...` |
| I1 | `apps/gateway/src/dashboard.ts`, `packages/persistence/src/store.ts` | `dashboard.test.ts` durable pending evidence projection |
| I2 | `dashboard.ts`, `apps/web/src/app.test.tsx` | disabled `canStop=false`/`canRetry=false` UI regression |
| N1 | `apps/gateway/src/lifecycle.ts` | HTTP/Slack/Telegram boundary parameterized shutdown test |
| N2 | `apps/gateway/src/production.ts` | config reject DB-file absence 및 startup order production test |
| N3 | `production.test.ts`, `entry.test.ts`, `end-to-end.test.ts` | production startup/fail-closed, entry, `acceptCommand → delivery` 실행 |

### 검증과 커밋

- focused: `pnpm vitest run apps/gateway/test` — 7 files, 39 tests passed; `pnpm vitest run --project orca-hq-web apps/web/src/app.test.tsx` — 24 tests passed.
- 전체: `pnpm test` — 30 files, 500 tests passed; `pnpm typecheck` — exit 0; `pnpm build` — 13 workspace projects exit 0; `pnpm --filter @orca-hq/web test:e2e` — 4 passed; `git diff --check a927feef333bf94a021a89970679796d1b9e4975..HEAD` 및 worktree diff check — exit 0.
- 커밋: `fix(gateway): complete production lifecycle` (이 보고서가 포함된 원자적 커밋).

### 실제 남은 우려

- 실제 Slack/Telegram/Tailscale/Keychain/Orca 연결은 의도적으로 생성·변경하지 않았다. production에는 이 외부 I/O·secret 경계만 주입하며, 테스트는 fake client와 loopback/store를 사용한다.
