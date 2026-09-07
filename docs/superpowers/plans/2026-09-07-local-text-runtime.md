# 로컬 텍스트 조회 운영 모듈 구현 계획

사용자 승인: 별도 gateway 모듈이 없으며 이 저장소에서 구현한다. 기존 음성 비활성·5개 L0 프로젝트 설정을 사용한다. Codex는 로그인된 구독 인증을 사용한다.

## 제약

- 보호 대상 `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`는 읽기, 해시, diff, stage, restore 금지. status만 허용.
- 개발 worktree에서 변경하며 다른 작업자의 변경을 되돌리지 않는다. 실제 토큰은 Keychain에서만 읽고 출력·파일·명령행 인자에 기록하지 않는다.
- 첫 로컬 런타임은 L0 프로젝트 메타데이터 조회 전용. 도구 없는 Codex 요약으로 모델에 파일·셸 접근 권한을 주지 않는다. 기존 외부 모듈 확장 경로는 유지한다.
- 메시지 수신은 채널·대화 allowlist, 중복 제거, 재시작 복구와 제한된 입력 크기를 적용한다. UI·응답·보고서는 한국어.

## Task 1: 실제 Slack·Telegram 통신

파일: apps/gateway/src/local-channels.ts, apps/gateway/test/local-channels.test.ts
Node fetch/WebSocket으로 실제 API 연결. Keychain은 호출자가 읽어서 제공. Telegram getMe/getChat + long polling, Slack auth.test + conversations.info + Socket Mode. 네트워크 오류는 redacted category만 노출. 커서와 메시지는 호출자 저장소에 위임. 정규화 API 계약은 작업자에게 전달한다. 테스트는 모의 HTTP/WebSocket 경계로 실제 전송·수신·종료·인증 거부·중복/offset 보존을 검증한다.

## Task 2: Codex 구독 기반 도구 없는 요약

파일: apps/gateway/src/local-codex.ts, apps/gateway/test/local-codex.test.ts
CLI stdin으로 질문·검증된 메타데이터만 전달. --ignore-user-config와 인증 유지, 셸·앱·브라우저·컴퓨터·MCP·hooks·skills 도구 비활성. 실제 지원 플래그를 확인하고 도구 이벤트가 나오면 실패. bounded timeout/output, redacted errors. cwd는 저장소가 아닌 전용 빈 디렉터리. API 키 환경변수 전달 금지. 테스트는 프로세스 boundary를 주입한다.

## Task 3: 로컬 런타임과 설치 통합

파일: apps/gateway/src/local-runtime.ts, local-store.ts, entry.ts; installer credential/start/status 관련 파일 및 테스트.
외부 모듈 설정이 없고 voiceMode=disabled이며 Registry가 L0만 허용할 때 저장소 소유 로컬 런타임 사용. 각 요청을 SQLite에 먼저 저장하고 순서대로 처리한다. 정해진 git 읽기 명령만 실행하여 프로젝트 메타데이터 수집. 모델은 이 데이터만 요약한다. 연결 상태와 큐 상태는 loopback health에 표시한다. launchd가 config/PATH를 전달하고 start는 실제 health를 확인한다. Slack bot token만 별도로 입력하는 숨김 credential 명령 추가.

## Task 4: 검토·설치·실제 E2E

수정 영역 테스트 → typecheck → 전체 테스트/build → 독립 리뷰. 변경 파일만 설치본에 적용하고 저장된 credential 재사용. Slack bot token은 대화형 터미널에서 사용자가 직접 입력한다. 실행 및 실제 Telegram/Slack 요청→Codex→응답 검증. 실패와 L0 제한을 명시한 최종 보고.
