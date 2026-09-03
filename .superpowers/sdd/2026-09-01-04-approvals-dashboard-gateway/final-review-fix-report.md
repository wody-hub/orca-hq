# Plan 4 최종 리뷰 수정 파동 보고서

- 기준 커밋: `dfecc4755c8a99d07deb5dbec3a535648b527017`
- 구현 브랜치: `dev`
- 작업일: 2026-09-03 (Asia/Seoul)
- 범위: 최종 리뷰의 Critical 2건(C1~C2), Important 5건(I1~I5)
- 제외: Minor 7건, 실제 외부 서비스 설정·credential 변경, 사용자 소유 private-pilot roadmap, Playwright 산출물

## 결론

최종 리뷰에서 지적한 병합 차단 결함 7건을 모두 production 경로에 연결했다. L2/L3 제안은 durable 승인 없이는 Dispatch를 만들지 않으며, Gateway lifecycle이 Outbox 전달과 재기동 복구를 소유한다. 검증 완료 대상 해석 실패, malformed HQ 출력, Serve 불일치와 같은 실패는 원문을 노출하지 않는 durable audit/diagnostic으로 남고, 대시보드는 최근 20건의 승인·감사 증거를 분리해서 표시한다.

최신 HEAD 기준 전체 단위·통합 테스트 531개, TypeScript typecheck, 전체 workspace build, Chromium Playwright 4개, 기준 커밋 대비 `git diff --check`가 모두 통과했다.

## 구현 내용

### C1 — production L2/L3 durable 승인 게이트

- `productionCommandFlow`가 L2/L3 proposal을 받으면 `ApprovalService.request`로 proposal/operation/command digest에 결합된 요청을 먼저 저장한다.
- 재기동 가능한 실행 근거로 `run:<proposalId>`를 `waiting_approval`에 durable 저장하며, 이 시점에는 Task나 Dispatch를 만들지 않는다.
- L2는 `commit_changes`, L3는 `deploy_production` 및 production target에 결합된다.
- HTTP confirm 경로는 기존 durable request를 복원한 뒤 역할(owner/operator matrix), 허용 채널, exact digest, 15분 만료, L3 exact phrase를 `ApprovalService`로 검증한다.
- 검증 성공 시 승인 레코드를 단 한 번 `consumed`로 바꾼 후에만 해당 durable proposal/project를 다시 읽어 `ExecutionService.start`에 production 내부 authorization을 전달한다.
- 승인 request와 현재 proposal/command/operation digest가 달라지면 실행하지 않고 changed/denied로 닫힌다.
- 승인 소비 직후 프로세스가 중단되어 Run이 `waiting_approval`로 남은 경우에는 재기동 reconciliation이 동일 digest, operation, channel, 승인 시간창을 재검증한 후 한 번 실행을 이어간다.
- orphan approval fixture는 proposal/project 실행 근거가 없으므로 confirm 성공으로 바뀌지 않는다.

실경로 회귀는 다음을 고정한다.

1. L2 승인 전: `waiting_approval`, Task/Dispatch 0개.
2. L2 정상 승인 후: approval `consumed`, Run `active`, Dispatch 1개.
3. 같은 승인 재사용: HTTP 403, 추가 Dispatch 없음.
4. L3 오문구: HTTP 403, approval `pending`, Dispatch 없음.
5. L3 exact phrase: 실행 시작.
6. 승인 직후 만료 경계: approval `expired`, 실행 없음.
7. consumed handoff 크래시 재기동: 동일 proposal만 복구 실행.

### C2 — lifecycle-owned Outbox driver

- `GatewayOutboxDriver`를 추가해 Gateway 기동 시 `OutboxDispatcher.tick(now)` 단일 실행 루프를 시작하고 종료 시 정지한다.
- 반복 주기는 설정 가능한 bounded interval이며, 연속 실패에는 최대값이 있는 지수 backoff를 적용한다.
- tick은 single-flight이고, `stop()`은 예약 타이머를 제거한 뒤 현재 진행 중 tick을 await하므로 DB checkpoint/close 뒤에 새 tick이 실행되지 않는다.
- tick 오류는 process rejection으로 전파하지 않고 stable code `outbox_tick_failed`와 payload 없는 `outbox.tick_failed` 감사로 축약한다. 원시 provider/clock 예외는 diagnostic이나 audit에 넣지 않는다.
- Slack, Telegram, tailscale-web provider는 기존 durable claim/ack 경계를 그대로 사용한다.
- production E2E는 더 이상 `services.outbox.tick()`을 수동 호출하지 않고 lifecycle만으로 Outbox `delivered`를 기다린다.

### I1 — 실제 reconciliation

- 시작 시 TTL을 넘긴 `claimed` Outbox를 parameterized SQL로 `pending`에 되돌리고 claim metadata를 지운다.
- 회수된 메시지는 `next_attempt_at`을 현재 시각보다 늦지 않게 조정하고 `outbox.claim_recovered` 감사를 남긴다.
- 이어서 lifecycle-owned driver가 회수/기존 pending 메시지를 실제 전달한다.
- approved 또는 안전하게 복구 가능한 consumed approval handoff를 다시 관측해 실행 재개를 시도한다.
- Run/Dispatch의 비종단 잔여를 계산하고, 남아 있으면 개수만 포함한 `reconciliation_incomplete` diagnostic/audit을 남긴다.
- 재기동 테스트는 stale claim이 실제로 `delivered`가 되고 recovery audit이 생기는지 단정한다.

### I2 — 고정 HTTP 포트와 Tailscale Serve 진단

- Gateway config에 기본 고정 포트 `4310`을 추가하고 production Fastify listener가 `127.0.0.1:<httpPort>`를 사용한다.
- 포트 `0`은 `allowEphemeralHttpPortForTests: true`가 명시된 테스트에서만 허용된다.
- host 외부 설정에서 Serve 관측값을 strict schema로 검증해 내부 production composition으로 전달한다.
- HTTP listener 기동 직후 기존 Tailscale Serve diagnostics를 호출하며, configured upstream port와 실제 gateway port 불일치를 `upstream_port_mismatch`로 검출한다.
- 외부 주소나 실제 포트 값은 Gateway diagnostic에 포함하지 않고 stable reason enum만 노출한다.

### I3 — completion target 실패와 verification commit 분리

- completion target resolver를 total resolution(`target | unresolved`)으로 바꾸고 예외를 `resolver_failed`로 평탄화한다.
- 비-durable Run/Command, 잘못된 Telegram external message id, destination 누락을 각각 stable failure reason으로 반환한다.
- verification pass/intervention 결정은 Outbox target 또는 `deliveryTargetFailure` 중 정확히 하나와 함께 하나의 persistence transaction으로 commit된다.
- target이 없더라도 report, Run/Task 상태 전이, `verification.passed`/intervention audit은 보존된다.
- `delivery_target_unresolved` 감사는 report/task/run 식별자와 safe reason만 저장하며 resolver 원문 예외는 저장하지 않는다.
- malformed Telegram destination E2E에서 Run `verified_success`, Outbox 없음, verification audit과 unresolved audit 공존을 확인한다.

### I4 — malformed HQ 출력 typed failure/audit

- proposal model 결과는 `HqResultSchema.safeParse`로 검증하고 parse/throw/commandId mismatch를 `invalid_model_output` failure로 축약한다.
- 입력 command가 durable store에 없으면 throw 대신 `{ state: "failure" }`를 반환한다.
- 두 실패 모두 `command.planning_failed` audit을 남기며 audit data에는 stable reason만 넣는다.
- 테스트가 주입한 모델 secret과 원시 parser 예외가 응답/audit에 포함되지 않음을 확인한다.

### I5 — bounded approval/audit history

- command detail projection에 `approvalHistory`와 `auditHistory`를 추가하고 각각 최신 20건으로 제한했다.
- 현재 proposal의 승인 카드는 현재 proposal approval만 사용하되, history는 동일 command의 과거 proposal까지 포함한다.
- audit history는 command subject 및 그 command에 속한 모든 approval subject를 합쳐 최신순으로 투영한다.
- pending approval의 UI 권한은 현재 principal role로 계산한다: owner는 L2/L3, operator는 L2, viewer는 승인 불가다.
- wire 타입과 React UI를 확장해 승인 이력, 감사 이력, 채널 전달을 서로 다른 카드로 표시한다.
- expired, invalidated, denied 사건 및 20건 상한을 gateway/React/Playwright 회귀로 고정했다.

## TDD 기록

각 결함은 구현 전에 해당 production 또는 persistence 경로를 직접 통과하는 테스트를 추가해 RED를 확인했다.

| 항목 | RED에서 확인한 실패 | GREEN 근거 |
|---|---|---|
| C1 | L2/L3가 승인 요청 없이 즉시 Dispatch되거나 정상 production approval 자체가 존재하지 않음 | production E2E에서 승인 전 0 Dispatch, 승인 후 1 Dispatch, L3 오문구/만료/재사용 거부 |
| C2 | lifecycle만 실행하면 completion Outbox가 pending으로 남고 수동 tick이 필요함 | 수동 tick 제거 후 Telegram success 메시지가 lifecycle loop로 delivered |
| I1 | stale claimed Outbox가 재기동 뒤에도 claimed이고 비종단 Run 진단이 없음 | claim 회수·전달·recovery audit 및 `reconciliation_incomplete` 단정 |
| I2 | production listener가 port 0을 사용하고 Serve mismatch가 관측되지 않음 | 실제 가용 고정 포트 listen 및 redacted mismatch diagnostic 단정 |
| I3 | resolver throw/malformed Telegram id가 `commitVerification` 전에 빠져 verified evidence가 없음 | Run `verified_success`, `verification.passed`, `delivery_target_unresolved` 동시 보존 |
| I4 | malformed model 출력과 durable command 누락이 예외로 전파되고 audit이 없음 | typed failure와 stable reason audit, secret 비노출 |
| I5 | detail 응답/React에 최신 단일 snapshot만 존재 | 20건 history, expired/invalidated/denied, 분리 카드 회귀 |

초기 GREEN 뒤 자체 리뷰에서도 세 번 RED→GREEN을 반복했다.

- pending approval 카드가 승인 완료 상태에서만 `permitted`로 계산되던 문제를 역할 기반 pending 권한 테스트로 발견해 수정했다.
- approval consume과 execution start 사이 크래시가 재기동 시 영구 정지되는 문제를 consumed handoff E2E로 발견해 수정했다.
- 현재 proposal만 필터링해 같은 command의 과거 expired/denied 이력이 사라지는 문제를 cross-proposal history 테스트로 발견해 수정했다.

관련 targeted GREEN 결과:

- gateway dashboard/end-to-end/production 관련 테스트 27개 통과.
- consumed approval crash recovery 추가 후 end-to-end 테스트 10개 통과.
- pending 권한 및 cross-proposal history 추가 후 dashboard 테스트 3개 통과.

## 자체 리뷰

### 승인 replay·crash 경계

- normal resume는 `ApprovalService.validate`의 atomic consume을 통과해야 한다.
- consumed recovery는 Run이 여전히 정확한 `waiting_approval`일 때만 허용한다.
- request/proposal/operation/command/target/channel digest와 고정 15분 시간창을 다시 비교한다.
- execution이 이미 Run을 `active`로 전이한 뒤에는 consumed approval을 재사용하지 않는다.
- 중복 confirm E2E에서 추가 Dispatch가 만들어지지 않음을 확인했다.

### Outbox 종료 race·backoff

- timer callback은 한 번에 하나의 `#inFlight` promise만 만든다.
- `stop()`이 먼저 `#running = false`로 바꾸고 timer를 지운 다음 `#inFlight`를 await한다.
- tick `finally`의 reschedule은 `#running`을 재확인하므로 stop 이후 새 timer가 생기지 않는다.
- backoff는 poll interval 아래로 내려가지 않고 configured maximum을 넘지 않는다.

### SQL·원자성

- proposal 조회와 stale claim 회수의 모든 가변 값은 SQLite placeholder로 전달한다.
- stale claim 회수는 immediate transaction과 state predicate를 사용한다.
- verification report/decision/audit/delivery outcome은 기존 `commitVerification` transaction 안에서 함께 기록한다.

### enum consumer·redaction

- 신규 approval history 상태(`consumed`, `invalidated`)를 gateway wire type과 web API type에 반영했다.
- 신규 diagnostics는 lifecycle union에 명시하고, collection은 최대 100개로 제한했다.
- Serve/Outbox/HQ/completion failure의 원시 오류, 주소, port, secret은 audit/diagnostic으로 전달하지 않는다.
- dashboard project path는 계속 `[redacted]`이며 이 변경에서 credential이나 실제 외부 설정을 읽거나 쓰지 않았다.

## 호환성 및 운영 경계

- DB migration은 추가하지 않았다. 기존 tables/indexes를 그대로 사용하므로 기존 SQLite 데이터가 재마이그레이션 없이 열리며, stale claim recovery는 기존 `claimed_at` 컬럼을 이용한다.
- 기존 config 호출자는 새 runtime 필드의 default를 적용받는다. production HTTP는 이제 결정적인 기본 포트 4310을 사용하고, 기존 테스트의 ephemeral 포트는 명시적 test flag로만 유지한다.
- Serve 관측 설정은 repository-owned host boundary에서 fail-closed 검증되며, production dependencies의 직접 조합에서는 선택적이라 기존 비-HTTP/stub composition을 깨지 않는다.
- 외부 Slack, Telegram, Tailscale, Keychain, Orca 설정 및 credential에는 변경을 가하지 않았다.
- 사용자 소유 `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`는 내용 열람·수정·stage·restore하지 않았다.
- `apps/web/test-results/.last-run.json` 및 Playwright 결과물은 commit 대상에서 제외했다.

## 최종 검증

최신 구현 HEAD에서 다음을 다시 실행했다.

```text
pnpm test
  Test Files  30 passed (30)
  Tests       531 passed (531)

pnpm typecheck
  exit 0

pnpm build
  13/14 workspace projects build 완료, exit 0

pnpm --filter @orca-hq/web test:e2e
  Chromium 4 passed

git diff --check dfecc475..HEAD -- . \
  ':(exclude)docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md' \
  ':(exclude)apps/web/test-results/**'
  exit 0
```

## 원자 커밋

- `574ad69` `fix(gateway): enforce durable production approvals`
- `556c66d` `fix(verification): preserve evidence without delivery target`
- `08a0dc4` `fix(runtime): own durable delivery and recovery`
- `90336dd` `fix(dashboard): expose bounded evidence history`
- `53b6338` `fix(dashboard): enable authorized pending approvals`
- `a9fba7e` `fix(approvals): recover consumed execution handoff`
- `72238a3` `fix(gateway): retain command approval history`

## 남은 작업

이 수정 파동의 C1, C2, I1~I5에는 남은 구현 작업이 없다. 최종 리뷰의 Minor 7건은 요청 범위대로 건드리지 않았으며 후속 작업으로 분리할 수 있다.
