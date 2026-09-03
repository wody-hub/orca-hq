# Task 3 작업 보고서 — 조회·승인·제어 HTTP API

## 구현 내용

- `GET /api/commands`, `GET /api/commands/:id`, `GET /api/projects`와 `POST /api/approvals/:id/confirm`, `POST /api/actions/stop`, `POST /api/actions/retry`를 추가했다.
- HTTP 계층은 인증, 역할 인가, HTTPS Origin 일치, 현재 세션에 묶인 CSRF 토큰, 단일 비어 있지 않은 `Idempotency-Key`, Zod 입력 검증 및 generic 오류 응답만 처리한다.
- 조회, immutable approval 복원·확인, Dispatch stop/retry는 각 최소 주입 포트로 분리했다. 포트는 durable 멱등성·redacted audit의 원자적 처리를 담당하며, gateway는 `ControlStore`, `ExecutionService`, Orca CLI를 직접 사용하지 않는다.
- `/auth/session`의 기존 204와 보안 cookie 속성은 유지하면서 `x-csrf-token` 부트스트랩 헤더를 추가했다.

## TDD RED/GREEN 증거

1. RED: `pnpm test apps/gateway/test/api.test.ts`
   - 구현 전 9개 테스트가 실패했다. 핵심 오류는 `Error: test session bootstrap failed`였으며, 이는 `/auth/session`에 세션-결합 CSRF 부트스트랩이 없어서 발생했다.
2. 추가 RED: `pnpm test apps/gateway/test/api.test.ts`
   - HTTPS 설정 경계 테스트는 `expected 200 to be 403`으로 실패했다. HTTP origin 설정이 유효한 mutation을 허용하던 결함을 확인했다.
3. GREEN: 두 경계를 구현한 뒤 `pnpm test apps/gateway/test/api.test.ts`에서 10/10 통과했다.

## 검증 결과

- `pnpm test apps/gateway/test/api.test.ts` — 1개 파일, 10개 테스트 통과
- `pnpm test apps/gateway` — 2개 파일, 18개 테스트 통과
- `pnpm test` — 23개 파일, 450개 테스트 통과
- `pnpm typecheck` — 통과
- `pnpm build` — 통과
- `git diff --check` — 통과

## 변경 파일

- `apps/gateway/src/http.ts`
- `apps/gateway/src/routes/commands.ts`
- `apps/gateway/src/routes/projects.ts`
- `apps/gateway/src/routes/approvals.ts`
- `apps/gateway/src/routes/actions.ts`
- `apps/gateway/test/api.test.ts`
- `apps/gateway/package.json`, `pnpm-lock.yaml`
- 본 보고서

## 자체 검토

- 인증 전에는 모든 query/mutation 포트를 호출하지 않으며, 인증·인가 오류는 각각 metadata 없는 `401 {"error":"unauthorized"}`, `403 {"error":"forbidden"}`으로 유지한다.
- malformed params/body/header는 `400 {"error":"bad_request"}`, proposal digest 변경은 정확히 `409 {"error":"proposal_changed"}`, 명령 상세 미존재와 미등록 경로는 generic 404, 내부 예외는 generic 500으로 매핑된다.
- L3 phrase 및 L2/L3 역할 세부 판정은 저장된 immutable approval을 복원하는 승인 포트로 넘기고, route는 항상 `tailscale-web` 채널만 전달한다. action body는 `dispatchId` 외 필드를 strict하게 거부하므로 worktree·명령·경로 입력을 수용하지 않는다.

## 남은 우려

- Task 5가 실제 `ApprovalService`, 현재 proposal, durable action/audit 저장소를 각 포트에 조립해야 운영 경로가 완성된다. 이 Task의 gateway는 의도적으로 그 구현 의존성을 갖지 않는다.

## 수정 1차

### I1 — malformed JSON의 generic 400 매핑

- `apps/gateway/src/http.ts` error handler가 Zod 오류뿐 아니라 Fastify가 `statusCode`로 4xx를 판정한 입력 오류도 정확히 `400 {"error":"bad_request"}`로 평탄화하도록 변경했다. 이로써 `FST_ERR_CTP_INVALID_JSON`과 향후 unsupported content type 같은 framework 입력 오류는 parser 원문·오류 code·경로 없이 응답한다. 그 외 예외는 기존처럼 `500 {"error":"internal_error"}`이며, 이 계약은 `apps/gateway/test/http-auth.test.ts`의 실제 session-service 예외 테스트가 계속 고정한다.
- covering test: `apps/gateway/test/api.test.ts`의 `returns a generic bad request for malformed JSON before authentication`가 미인증 `POST /api/actions/stop`에 `{oops` JSON을 전송해 400과 단일 generic body, parser 원문 비노출을 확인한다.

### I2 — 무상태 HMAC CSRF

- 만료·삭제 경로가 없던 `csrfSessions` Map을 제거했다. gateway는 주입된 최소 32바이트 `csrfSigningKey`로 raw session token과 `principalId`를 함께 HMAC-SHA256하여 base64url CSRF 값을 결정적으로 발급하고, 검증 시 길이·encoding을 먼저 확인한 뒤 `timingSafeEqual`로 비교한다.
- 유효한 키가 없거나 32바이트보다 짧으면 CSRF 부트스트랩을 만들지 않고 mutation을 `403 {"error":"forbidden"}`으로 fail-closed 한다. 예측 가능한 기본 키나 프로세스별 random fallback은 없다.
- covering test: `apps/gateway/test/api.test.ts`의 `derives CSRF tokens across instances and rejects a different principal or signing key`가 같은 session/CSRF signing key의 두 app instance 사이에서 cookie와 CSRF token으로 mutation이 통과함을 검증하고, 다른 key 및 다른 principal CSRF는 403임을 확인한다. `fails closed for mutation APIs when the CSRF signing key is shorter than 32 bytes`는 짧은 key에서의 fail-closed 경계를 고정한다.

### RED/GREEN 및 회귀 결과

- RED: `pnpm test apps/gateway/test/api.test.ts` 실행에서 13개 중 3개가 의도대로 실패했다. 핵심 출력은 malformed JSON의 `expected 500 to be 400`, 새 instance CSRF의 `expected 403 to be 200`, 짧은 key의 `expected 200 to be 403`이었다.
- GREEN: `pnpm test apps/gateway/test/api.test.ts apps/gateway/test/http-auth.test.ts` — 2 files, 21 tests 통과.
- 전체 회귀: `pnpm test` — 23 files, 453 tests 통과; `pnpm typecheck` 통과; `pnpm build` 통과; `git diff --check` 통과.
- 커밋: `0e741c6 fix(api): harden gateway request boundaries`.

### 남은 우려

- Task 5의 실제 조립 단계는 Keychain에서 안정적인 32바이트 이상 `csrfSigningKey`를 주입해야 한다. 키 누락 또는 형식 오류 상태에서는 의도적으로 mutation이 모두 403이므로, 배포 설정 검증이 필요하다.
