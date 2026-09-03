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

## 수정 3차

### 구현 및 데이터 흐름

- 저장소 소유 `host.ts → entry.ts → production.ts` 경로를 추가해 `GATEWAY_HOST_BOOTSTRAP`이라는 저장소 밖 host 모듈 의존을 제거했다. deployment는 Keychain/Slack/Telegram/Tailscale/Orca 외부 경계만 `GATEWAY_EXTERNAL_ADAPTERS`로 공급하며, 기본 host가 없어서 실패하지 않고 설정 부재는 redacted 오류로 fail-closed 한다.
- production HTTP는 실제 ControlStore 기반 command/project dashboard, persisted approval confirmation, dispatch control adapter를 직접 조립한다. dashboard는 run recovery proposal, task/dispatch, approval, audit, outbox를 읽어 unknown/pending을 보수적으로 표시하고 `verification_failed`를 failed로 표시한다.
- migration 조립 중 HTTP 설정이 빠져도 openDatabase handle을 즉시 close하도록 ownership을 잡았다. HTTP/Slack/Telegram 시작 경계별 종료 테스트는 시작된 ingress를 역순 stop한 뒤 drain/checkpoint/close하는 literal 순서를 검증한다.

### TDD RED/GREEN

- RED: durable L3 proposal/approval과 `verification_failed` run을 넣은 dashboard test는 기존 L0/unrouted/pending placeholder를 반환해 실패했다. HTTP composition failure test는 기존 lifecycle ownership 이전 DB handle close 누락을 재현하도록 추가했다.
- GREEN: `pnpm vitest run apps/gateway/test/end-to-end.test.ts apps/gateway/test/production.test.ts apps/gateway/test/dashboard.test.ts apps/gateway/test/entry.test.ts apps/gateway/test/lifecycle.test.ts`는 5 files, 20 tests passed였다. Telegram 501 normalization, durable verified state, implementer/verifier dispatch 2건, real Outbox final Telegram delivery, production projects/approval/action route, DB cleanup을 포함한다.

### 9개 finding 대응

| Finding | 대응 |
| --- | --- |
| C1 | 저장소 소유 host/entry와 injected external boundary 성공 경로 테스트 |
| C3 | Telegram 501 durable run/2 dispatch/Outbox delivery 및 L0-L3 exact policy 회귀 |
| I1 | proposal/task/approval/audit/outbox 기반 dashboard projection |
| N3 | production HTTP, entry, acceptCommand→durable evidence→Outbox 실행 |
| N8 | unknown 위험도, failed verification, durable approval/contract/routing 표시 |
| N9 | production-owned projects/approval/actions adapters와 actual route test |
| N10 | migrate composition 예외에서 database close 회귀 |
| N11 | 실제 boundary별 reverse ingress stop literal sequence |
| N12 | delivery 문자열을 command-flow fake 반환값에서 받지 않고 durable Outbox dispatch로 검증 |

### 검증 및 self-review

```text
pnpm test                                      30 files, 503 tests passed
pnpm typecheck                                 exit 0
pnpm build                                     exit 0 (13 workspace projects)
pnpm --filter @orca-hq/web test:e2e            4 passed
git diff --check                               exit 0
```

- self-review에서 unknown risk가 L0으로 강등되지 않는지, approval/dispatch adapter가 undefined 500이 아니라 durable fail-closed 결정을 내리는지, config 거부 시 DB 파일 생성 계약이 유지되는지 확인했다.
- 실제 Slack/Telegram/Tailscale/Keychain/Orca credential 또는 설정은 생성·변경하지 않았다. Playwright가 만든 `apps/web/test-results/.last-run.json`은 untracked test artifact로 남아 있으며 커밋하지 않는다.

## 수정 4차

### RED/GREEN 증거

- RED: `pnpm vitest run apps/gateway/test/dashboard.test.ts`에서 durable verifier Task의 `report.diffSummary`가 있어도 dashboard가 `"pending"`을 반환하고 L3 `operationPhrase`가 없는 것을 재현했다. GREEN: 같은 테스트는 verifier report의 `"1 file changed"`와 immutable digest에서 재구성한 `APPROVE DEPLOY_PRODUCTION ...` 문구를 검증한다.
- RED: `pnpm vitest run apps/gateway/test/production.test.ts`에서 정확한 L2 digest 확인은 기존 production adapter의 `service.request(persisted.request)` strict-schema 오류 때문에 HTTP 400을 반환했다. GREEN: 실제 loopback HTTP에서 L2 200, 잘못된 L3 phrase 403, 정확히 재구성된 L3 phrase 200을 확인했다.
- RED: 같은 production 테스트에서 동일 stop idempotency key가 external control을 두 번 호출했다. GREEN: 실제 durable dispatch 대상으로 stop/retry HTTP 200, 외부 control 각 한 번, `dispatch.stop_requested`/`dispatch.retry_requested` audit 두 건을 확인했다.

### 변경 데이터 흐름

- dashboard의 diff는 존재하지 않는 `RunRecord.diffSummary` 대신 terminal verifier Task payload의 durable `report.diffSummary`에서 계산한다. verification evidence가 없으면만 `pending`을 반환한다.
- persisted approval은 새 request로 다시 parse하지 않고 immutable durable request를 복원한다. L3 문구는 operation과 digest에서 정규화해 서버 projection과 confirmation 양쪽에서 재구성하며, malformed/stale durable 값은 catch하여 fail-closed 한다.
- production HTTP action은 optional deny-all을 제거하고 필수 `dispatchControl`을 요구한다. durable dispatch 존재, idempotency key의 동일 대상/action, redacted audit을 확인한 뒤에만 I/O port를 호출한다.
- production composition은 외부 `commandFlow`와 delivery port를 받지 않는다. 저장소 코드가 durable command를 HQ 계획으로 넘기고 proposal을 저장한 다음 등록 project와 concrete `ExecutionService.start`를 연결한다.

### Finding별 self-review

| Finding | 결과 |
| --- | --- |
| C1 | `commandFlow`/delivery 외부 주입을 제거했으나, legacy reconcile hook과 execution option 경계는 추가 구조 정리가 필요하다. |
| C3, N3, N12 | production command flow는 repository-owned로 바뀌었지만 기존 end-to-end 테스트가 실제 ExecutionService의 worker/verifier completion까지 아직 실행하지 않아 남은 회귀가 있다. |
| I1, N21 | terminal verifier report의 durable diff summary를 HTTP dashboard projection으로 사용해 해결했다. |
| N9, N19 | strict input 재투입을 없애고 valid L2/L3 HTTP 성공과 mismatch fail-closed를 회귀했다. |
| N20 | required dispatch control, real durable dispatch HTTP 성공, 동일 key idempotency/audit 회귀를 추가했다. |
| N22 | immutable digest 기반 L3 phrase projection을 복원해 UI가 정확한 문구를 표시·입력할 수 있게 했다. |

### 검증

```text
pnpm test                                      30 files, 505 tests passed
pnpm typecheck                                 exit 0
pnpm build                                     exit 0 (13 workspace projects)
pnpm --filter @orca-hq/web test:e2e            4 passed
git diff --check                               exit 0
```

### 남은 우려

- C1/C3/N3/N12의 권위 있는 요구인 repository-owned host 성공 경로와 실제 ExecutionService의 worker→verifier→verification-failure Outbox 차단 E2E는 아직 별도 RED/GREEN으로 완결하지 못했다. 이 절의 변경은 해당 사실을 숨기지 않으며, 후속 작업에서 external bootstrap dependency를 Keychain/channel/Orca 경계로 더 축소하고 full durable state-machine E2E를 추가해야 한다.

## 수정 5차

### 구현 및 조립 경계

- `host.ts`는 더 이상 외부 모듈의 완성된 `{ config, dependencies }`를 통과시키지 않는다. 외부 모듈에는 config/secret 검증, Orca·Git·channel·outbound·dispatch-control I/O, model proposal, 승인된 Orca project 발견 결과와 curated registry 파일 경로만 허용한다. 저장소의 `Registry.load`가 YAML과 발견 결과를 교차 검증하고 host가 `GitWorktreePlacementService`, `FileAssignmentArtifactStore`, execution option, Outbox option을 직접 조립한다. `dependencies`, `commandFlow`, `reconcile`, `execution`, `outbox`, 완성 host를 반환하면 redacted configuration 오류로 거부한다.
- `production.ts`는 외부 model 출력을 `HqResultSchema`로 검증하는 HQ wrapper, durable `ControlStore`, `WorktreeLockService`, `ExecutionLifecycle`, `VerificationService`, `ExecutionService`, `OutboxDispatcher`, HTTP/dashboard/approval/action 포트와 store-owned reconciliation 경계를 직접 조립한다. production command flow가 durable command를 찾고 proposal을 저장한 뒤 등록 project와 `ExecutionService.start`를 연결한다.
- verification completion target은 durable Run→Command 관계에서 command ID와 channel을 찾고 Telegram의 normalized `chatId:messageId`에서 destination을 계산한다. `VerificationService`가 생성하는 성공 payload의 literal text는 `검증 완료`이며, bounded Fix Task를 만드는 실패는 delivery target을 조회하거나 Outbox를 만들지 않는다.
- 실제 production 경로가 발견한 ordering 결함을 `002-worktree-lock-reservations` migration으로 수정했다. `ExecutionService`의 권위 불변식인 “Dispatch persist 전 editing lease 예약”을 유지하면서 `worktree_locks.dispatch_id`의 선행 Dispatch FK만 제거했고, v1 active lease 보존과 future Dispatch 예약을 migration 회귀 테스트로 고정했다.

### TDD RED/GREEN

최초 host/E2E RED는 다음과 같았다.

```text
pnpm vitest run apps/gateway/test/entry.test.ts apps/gateway/test/end-to-end.test.ts
2 files failed, 4 tests failed, 2 passed
```

기존 `createGatewayHost`가 주입 loader를 무시하고 `GATEWAY_EXTERNAL_ADAPTERS`에서 full dependency graph를 읽었으며, E2E는 repository-owned production 상태 머신을 실행할 수 없었다. host/production 조립 뒤 실제 L1 실행이 Dispatch 생성 전 lease를 얻는 단계까지 진행하면서 SQLite v1 FK 결함도 다음 RED로 드러났다.

```text
pnpm vitest run packages/project-registry/test/locks.test.ts apps/gateway/test/end-to-end.test.ts
2 files failed, 3 tests failed, 12 passed
SqliteError: FOREIGN KEY constraint failed
ControlStore.acquireWorktreeLock → WorktreeLockService.acquire → ExecutionService.start
```

또한 동적 completion route를 self-review하면서 실패 Fix cycle이 불필요한 delivery destination 조회 때문에 중단되는 RED를 추가했다.

```text
pnpm vitest run packages/worker-routing/test/verifier.test.ts -t "does not resolve a delivery target"
1 test failed, 36 skipped
Error: delivery destination unavailable
```

최종 focused GREEN은 host/production/E2E, lock migration과 4차 HTTP 회귀를 함께 실행했다.

```text
pnpm vitest run packages/persistence/test/store.test.ts packages/project-registry/test/locks.test.ts apps/gateway/test/entry.test.ts apps/gateway/test/end-to-end.test.ts apps/gateway/test/production.test.ts
5 files passed, 46 tests passed

pnpm vitest run packages/worker-routing/test/verifier.test.ts -t "does not resolve a delivery target"
1 test passed, 36 skipped
```

### 실제 상태 전이와 외부 fake 경계

- 성공: 실제 Telegram adapter가 update 501을 normalized durable command로 저장하고, production HQ wrapper와 command flow가 L1 proposal을 저장한다. 실제 `ExecutionService`가 implementation Task/Dispatch를 만든 뒤 `recordWorkerMessage(worker_done)`가 반대 family verifier Task/Dispatch를 만들며, 실제 verification pass가 Run을 `verified_success`로 전이한다. Dispatch I/O는 정확히 2회다.
- 성공 전달: verification commit이 `report-command-501:success` Outbox를 command ID, `telegram`, destination `20`과 함께 enqueue한다. 실제 `OutboxDispatcher.tick()`과 Telegram renderer/provider fake를 통과한 durable 행은 `delivered`, provider message ID `9001`이며 외부 delivery는 literal `검증 완료` 한 건이다.
- 실패: 같은 실제 worker/verifier 경로에서 fail report는 verifier Task를 `verification_failed`로 저장하고 Run은 bounded fix cycle 때문에 `active`를 유지하며 `verification.failed` audit을 남긴다. success Outbox와 외부 delivery는 모두 0건이다.
- L0: 동일한 production command flow가 approval 없이 investigate Task/Dispatch 하나를 실행하고 worker completion 뒤 Run을 `investigation_complete`로 전이한다. approval, verifier, Outbox는 생성하지 않는다.
- deterministic fake는 secret validation, Orca receipts, Git/worktree I/O, model proposal, verification evidence, channel ingress lifecycle과 outbound provider에만 있다. project registry는 임시 실제 YAML을 저장소 `Registry.load`로 읽고, 상태·Task·Dispatch·verification·Outbox는 fake가 직접 insert하지 않는다.

### Finding 및 4차 회귀 self-review

| Finding | 결과 및 근거 |
| --- | --- |
| C1 | 해결. `host.ts`가 최소 external boundary를 검증하고 project registry/execution/Outbox option을 조립하며, `production.ts`가 HQ command flow/verification/execution/HTTP/reconciliation을 소유한다. `entry.test.ts`는 host→entry→production 성공과 prebuilt dependency 거부를 실행한다. |
| C3 | 해결. `end-to-end.test.ts`는 fake command flow와 직접 durable insert를 제거하고 실제 `ExecutionService` worker/verifier completion 및 verification commit을 실행한다. |
| N3 | 해결. normalized Telegram ingress부터 production accept, durable evidence, 실제 Outbox tick과 renderer까지 단일 실행 경로로 연결했다. |
| N12 | 해결. expected text는 literal `검증 완료`이고 product `VerificationService`가 payload를 만들며, fake는 전달된 text를 기록만 한다. 성공/실패 양쪽에서 Outbox와 delivery를 별도 단정한다. |
| 수정 4차 보존 | `production.test.ts`의 실제 HTTP L2 exact digest 200, L3 wrong phrase 403/exact phrase 200, durable dispatch stop/retry 각 1회 I/O와 redacted audit가 GREEN이다. 전체 suite에는 durable verifier diff, unknown risk, `verification_failed` 표시 회귀도 포함된다. |

### 전체 검증

```text
pnpm test                                      30 files, 509 tests passed
pnpm typecheck                                 exit 0
pnpm build                                     exit 0 (13 workspace projects)
pnpm --filter @orca-hq/web test:e2e            4 passed
git diff --check                               exit 0
```

Playwright에는 `NO_COLOR`/`FORCE_COLOR` Node 경고만 있었고 실패는 없었다. 실제 Slack, Telegram, Tailscale, Keychain, Orca credential·설정·network는 생성하거나 변경하지 않았다. 사용자 소유 roadmap과 Playwright `apps/web/test-results/` 산출물은 수정·stage·commit하지 않는다.

### 변경 파일, 커밋 및 남은 우려

- 변경 파일은 `apps/gateway/src/{entry,host,production}.ts`, `apps/gateway/test/{entry,end-to-end,production}.test.ts`, `packages/persistence/{package.json,src/database.ts,src/migrations/002-worktree-lock-reservations.ts,test/store.test.ts}`, `packages/project-registry/test/locks.test.ts`, `packages/worker-routing/src/verifier.ts`, `packages/worker-routing/test/verifier.test.ts`와 이 보고서다.
- 커밋은 이 절 작성 뒤 의도된 파일만 stage해 하나의 원자적 커밋으로 만든다.
- 남은 우려는 deployment가 실제 external boundary와 Slack/Tailscale completion destination을 올바르게 제공해야 한다는 점이다. 이번 테스트는 의도대로 실제 credential/provider connection을 만들지 않으며, 그 운영 설정의 가용성은 배포 canary 범위다.
