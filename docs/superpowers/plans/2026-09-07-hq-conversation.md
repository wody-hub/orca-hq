# HQ 대화형 프로젝트 작업 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. 기존 Orca worktree에서 작업. 명시한 파일만 수정하고 커밋하지 않는다.

**Goal:** 프로젝트 이름을 외우지 않아도 세 채널에서 찾기·선택·등록·생성 논의 후 Orca 작업을 지시한다.
**Architecture:** 도구 없는 Codex 구조화 추론 + 서버 검증 + 영속 대화 상태 + 기존 Orca relay.
**Tech Stack:** TypeScript, Zod, SQLite, Node readline, 기존 Codex CLI.

## Global Constraints

- 보호 파일 docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md의 내용 읽기/수정/hash/diff/stage/restore 금지.
- 사용자 원본 코드와 미커밋 변경 보존. 비밀 출력 금지. API 키 추가 요구 없음.
- 생성은 없는 경로만, 등록/생성 최종 제안 확인 후 수행. 작업은 native Orca만.

### Task 1: 터미널 대화
Files: packages/installer/src/{cli,control,chat}.ts 및 대응 test.
Interface: ControlClient.send(text:string) 기존 호환. createControlClient({sessionId?:string})로 POST body sessionId optional 전달. hq chat [--session ID], hq ask [--session ID] text. 별도 세션 ID의 형식은 /^[A-Za-z0-9_-]{1,100}$/.
- [x] 스트림 기반 두 번 질문, 같은 sessionId, EOF 종료, 잘못된 세션 거절 테스트 RED.
- [x] readline chat 구현과 CLI 분기, 기본 유한 timeout 60초.
- [x] installer 테스트 GREEN 및 typecheck.

### Task 2: 실제 폴더 탐색·생성
Files: apps/gateway/src/project-locations.ts 및 test/project-locations.test.ts.
Interface: createProjectLocations().search(root:string,query:string):Promise<{paths:string[];truncated:boolean}>, .create(path:string):Promise<string>.
- [x] 실제 임시 Git 저장소 발견, 깊이/항목 제한, symlink 미추적, 기존 경로 비변경 테스트 RED.
- [x] 절대 경로 검증, 제한 탐색, 빈 Git 초기화 및 초기 빈 커밋 구현. 홈/시스템/비밀 경로 직접 탐색 제한. 파일 내용 미독해.
- [x] 테스트 GREEN. 생성 작업은 대화 계층이 확인한 뒤만 호출.

### Task 3: AI 대화 및 채널 연결
Files: apps/gateway/src/{managed-conversation,conversation-ai,managed-runtime,managed-service,managed-control,managed-commands,local-codex}.ts 및 대응 tests.
Interface: execute(ManagedCommandInput)이며 conversationId optional 서버 생성, sessionId optional terminal 입력. 구조화 AI 결정은 ask/candidates/use/search/propose/followup. 실제 core /hq 명령으로 전달.
- [x] 다중 후보 선택·원래 지시 보존·대화 분리·확인 전 생성 없음·재시작·잘못된 ID 거절 RED.
- [x] SQLite 대화 상태 및 제한 기록, 실제 Codex 도구 없는 추론, 서버 ID 검증 구현.
- [x] Slack/Telegram thread 기반 ID와 terminal sessionId 연결. runtime 전환.
- [x] 관련 테스트 GREEN, 전체 테스트/typecheck/build, 검토.

### Task 4: 설치 및 실제 검증
- [x] 변경 파일을 명시 백업·복사 후 build, 서비스 재시작.
- [ ] 실제 Codex 후보 추론과 터미널 대화 검증 완료. 개인 Slack 새 대화 시험은 macOS 접근성 차단으로 사용자 입력 대기.
- [x] doctor --format json, health와 tailnet 검증.
- [x] 한국어 사용 가이드와 작업 보고서 작성, 검증되지 않은 Telegram E2E와 기타 제약 구분.

최종 결과: 65 files / 881 tests PASS, typecheck/build PASS. 자세한 설치·실제 검증과 남은 Slack/Telegram 확인은 ~/.config/orca-hq/20260907-conversation-report.md 참조.
