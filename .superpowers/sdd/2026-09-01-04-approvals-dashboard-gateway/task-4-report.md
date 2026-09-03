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
