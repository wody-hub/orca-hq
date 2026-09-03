# Task 4 모바일 Tailscale 대시보드 보고서

## 구현 결과

`apps/web`에 React/Vite 기반의 private dashboard를 추가했다. 명령 목록과 상세 화면은 프로젝트·경로, route evidence, 변경 계약, Task DAG, worker/verifier, diff/test, approval, audit, Slack/Telegram 전달 상태와 Dispatch 제어를 모바일 단일 열과 데스크톱 2열에서 제공한다. API 경계는 직렬화 가능한 secret-free view 타입으로 정의했으며, same-origin 세션 부트스트랩, 메모리 전용 CSRF token, credentials, 요청별 idempotency key와 digest-bound mutation을 사용한다.

## TDD RED/GREEN 증거

1. RED: `pnpm --filter @orca-hq/web test`를 실행했을 때 `Cannot find module './app.js'`로 실패했다. 아직 앱 생산 코드가 없으므로 예상한 실패였다.
2. GREEN: 목록/상세 증거 분리, L3 정확 문구, digest/phrase payload, Dispatch ID 한정 제어, 401 일반화, 만료 승인, 직접 URL 세션 부트스트랩, 제어 성공 상태를 고정한 단위 테스트 6건을 구현 후 통과시켰다.
3. 추가 RED/GREEN: 직접 URL의 bootstrap 호출과 Dispatch 중지 성공 상태 테스트는 각각 구현 전 실패했으며, `App`의 URL 부트스트랩과 제어 상태 UI 추가 후 통과했다.

## Playwright 실측

`pnpm --filter @orca-hq/web test:e2e`에서 deterministic same-origin route mock으로 Chromium을 실행했다.

- 390×844: 목록→상세 핵심 증거와 `Slack 전송 대기`가 표시되고 `document.documentElement.scrollWidth <= window.innerWidth`를 통과했다.
- 1280×800: 같은 정보와 제어가 접근 가능하고 수평 overflow가 없었다.
- L3: 부분/대소문자 불일치 문구에서는 disabled, 정확한 `APPROVE RELEASE`에서만 enabled이며 body는 `{ digest, phrase }`였다.

## 최종 검증

다음 명령을 통과했다.

```text
pnpm --filter @orca-hq/web test       # 6 passed
pnpm --filter @orca-hq/web test:e2e  # 3 passed
pnpm --filter @orca-hq/web build
pnpm test                            # 459 passed
pnpm typecheck
pnpm build
git diff --check
```

production `apps/web/dist`에는 `/Users/`, `/srv/`, secret/API key, private-key sentinel 패턴이 없음을 검사했다. fixture의 redacted path는 테스트 소스에만 있고 production asset에는 실제 회사 경로나 runtime configuration, cookie, credential, CSRF signing key가 없다.

## 자체 리뷰와 남은 사항

landmark, heading, 한국어 접근 가능한 이름, focus-visible, 44px controls, reduced-motion, 상태의 텍스트 표기와 코드 영역 줄바꿈을 확인했다. L3 입력은 저장하지 않고 승인 성공 시 지우며, 만료·처리됨·권한 없음과 mutation 중복 클릭을 비활성화한다. 실제 Gateway 상세 query adapter 및 Tailscale Serve 조립은 계획대로 Task 5의 책임으로 남아 있다.

## 변경 파일

- `apps/web/**`의 Vite 앱, API client, UI, 단위/E2E 테스트와 설정
- `pnpm-lock.yaml`
- 루트 `tsconfig.json`, `vitest.config.ts`의 TSX/웹 테스트 인식 설정

## 수정 1차 — 독립 리뷰 Critical·Important 대응

### TDD RED/GREEN 증거

생산 코드 변경 전에 `apps/web/src/app.test.tsx`에 실패 검증·다중 Task의 두 번째 Dispatch 제어·L3 문구/변경 계약·문구 누락 fail-closed·브라우저 뒤로가기·오류 연결 상태·권한/처리됨/진행 중 승인 차단·빈 목록/403/404/409/네트워크 오류·main live region 범위 테스트를 추가했다. 이 상태에서 `pnpm --filter @orca-hq/web test`는 20개 중 8개 실패로 RED를 기록했으며, 실패 사유는 정확히 상수 `검증 완료`, 첫 Task 고정 제어, phrase/계약 미표시, popstate 미구독, 오류 중 `연결됨`, broad `main` live region이었다. 독립 리뷰의 후속 Important 두 건도 실패 테스트로 추가해, 승인 요청 오류 뒤 재시도 불가와 늦게 끝난 상세 요청이 목록 탐색을 덮어쓰는 RED를 확인했다. 최소 구현 후 단위 테스트 22/22와 Playwright 4/4가 통과했다.

### 해결 내용

- C1: verification status를 `완료/passed`, `대기/pending`, `실패/failed`의 한글 라벨로 매핑했다. 실패에서는 `검증 실패`만 표시되며 `검증 완료`는 표시되지 않는다.
- C2: command 전역의 `tasks[0]` 제어를 제거하고, Task DAG 각 행의 제목과 Dispatch ID가 포함된 접근 가능한 stop/retry 버튼으로 바꿨다. 다중 Task fixture에서 두 번째 Task만 제어 API에 전달됨을 검증했다.
- I1/I2: 승인 카드 안에 허용된 L3 operation phrase와 base·허용 scope·금지 효과·검증 명령을 표시했다. L3 phrase 누락 시 입력과 승인 버튼을 비활성화하고 원인을 안내한다.
- I3/I4: `popstate`를 구독해 history 경로를 push 없이 다시 로드하고 cleanup한다. 헤더는 loading/ready/error/not-found 상태에서 각각 오해 없는 갱신 상태를 표시한다.
- I5: `main`의 broad `aria-live`를 제거하고 로딩·오류·mutation 결과의 좁은 상태 영역만 알리도록 했다.
- I6: 단위 20건과 Playwright 4건으로 승인 불가 경계, 일반화 오류/재시도, 빈 목록, 다중 Dispatch, back navigation, 두 viewport의 필수 증거, 키보드 `:focus-visible`, L3 phrase/계약 요약을 고정했다.
- 독립 리뷰 후속: 오류 상태의 승인 버튼은 다시 시도할 수 있게 하고, 최신 탐색 epoch와 일치하지 않는 비동기 목록/상세 응답은 무시해 stale response가 URL·화면을 되돌리지 못하게 했다.

### 수정 1차 검증

```text
pnpm --filter @orca-hq/web test       # 22 passed
pnpm --filter @orca-hq/web test:e2e  # 4 passed (390×844, 1280×800, 키보드 focus, L3 payload)
pnpm --filter @orca-hq/web build
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

production asset은 build 후 `/Users/`, `/srv/`, `secret`, `api[_-]?key`, `PRIVATE KEY`, `test-csrf`, `redacted/hq`, `APPROVE RELEASE` 패턴을 검사한다. Playwright의 `test-results/` 및 `playwright-report/`은 커밋하지 않고 작업 트리에 남기지 않는다.

### 유예 Minor

이번 라운드는 M1–M10을 직접 수정하지 않았다. 특히 기존 보고서의 “44px controls” 표현은 링크까지 충족한다는 뜻으로 읽히지 않으며, 링크 터치 영역 M1은 유예 상태다; CSRF 누락(M2), 빈 200 응답(M3), 만료 타이머(M4), L2 완료 직후 상태(M5), 현재 단계(M6), 데스크톱 2열(M7), Playwright ignore(M8) 및 기존 보고서 정합성의 나머지 항목(M10)은 후속 범위로 남긴다. M9의 mount 1회 bootstrap 변경과 bounded 401 재인증은 아래 수정 2차에서 실제 구현과 일치하게 정정한다.

## 수정 2차 — 세션 복구와 위험 제어 배치

### Important 1 — 15분 세션 만료 뒤 복구 가능한 재인증

- 원인: 앱 mount의 `bootstrap()`만으로는 15분 고정 세션 만료 뒤 API의 401을 새 세션과 CSRF로 복구할 경로가 없었다. mutation은 첫 요청 시점의 CSRF 헤더 객체를 재사용하므로, 단순 재시도만으로는 새 CSRF를 사용하지 못한다.
- RED: `apps/web/src/api.test.ts`에서 query의 `/api/commands` 401 → `/auth/session` 성공 → 원래 query 성공 순서, mutation의 오래된/새 CSRF와 동일 `Idempotency-Key`, 영구 401과 bootstrap 실패의 단 한 번 경계를 추가했다. 생산 코드 전 `pnpm --filter @orca-hq/web test`는 이 네 동작이 빠져 4건 실패했다.
- 수정: 공통 `request()` 경계는 401에서만 `bootstrap()`을 한 번 호출하고 같은 요청을 한 번만 다시 보낸다. mutation 요청 초기화는 재시도마다 CSRF를 다시 읽되 idempotency key와 `{ dispatchId }` 같은 최소 body를 보존한다; `/auth/session`의 401·네트워크 오류·403·404·409·5xx는 재시도 루프를 만들지 않고 기존 일반화된 `DashboardApiError`로 끝난다.
- GREEN: query와 mutation의 실제 fetch 순서, 새 CSRF, body 최소화, 동일 key, 영구 401, bootstrap 실패, bootstrap 자체 401 단발을 포함한 API 테스트가 통과했다.

### Important 2 — Dispatch 제어를 상세 증거 뒤에 배치

- 원인: 다중 Task의 올바른 `dispatchId` 제어를 Task DAG 행에 넣으면서 파괴적 stop/retry 버튼이 diff/test·승인·감사 증거보다 먼저 렌더되었다.
- RED: `apps/web/src/app.test.tsx`에 Task DAG, diff/test, 승인, 감사 및 채널 전달, Dispatch 제어의 카드 DOM 순서를 직접 비교하는 테스트를 추가했고, 기존 구조에서는 `Dispatch 제어` heading이 없어 실패했다.
- 수정: Task DAG를 Task·의존성·worker/verifier·Dispatch 상태만 보여주는 읽기 전용 증거 카드로 복원했다. 별도 `Dispatch 제어` 카드를 감사 및 채널 전달 뒤로 옮기고, Task별 접근 가능한 이름, 정확한 `dispatchId` payload, worktree 비삭제 안내와 다중 Task 제어를 유지했다.
- GREEN: 승인·감사·Dispatch 제어의 순서와 두 번째 Task만 stop/retry하는 기존 회귀 테스트가 함께 통과했다.

### 수정 2차 검증과 유예 사항

`pnpm --filter @orca-hq/web test`는 API 5건과 화면 23건, 총 28건을 통과했다. 수정 1차의 M9 기록은 정정한다: mount 1회 bootstrap으로 변경한 뒤, 수정 2차에서 bounded 401 재인증을 구현해 만료 세션은 공통 API 경계에서 한 번만 재수립한다.

새 Minor 1·3·4·5·6과 수정 1차의 나머지 Minor는 유예한다. Task 5에서 `commandId` 대 `id` 매핑, 상세 view 확장, verification 값 집합, Task별 `canStop`/`canRetry`, Tailscale Serve·정적 asset serving·`/commands/:id` SPA fallback 계약을 명시적으로 확인한다.
