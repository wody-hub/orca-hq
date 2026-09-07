# HQ Codex Session Implementation Plan

> subagent-driven-development와 TDD로 경계별 구현 후 통합 리뷰한다.

**Goal:** Codex 세션이 Orca 도구를 사용하여 대화를 주도한다.
**Architecture:** app-server JSON RPC transport + persisted channel sessions + native Orca tools; 기존 managed service/relay 재사용.
**Tech Stack:** TypeScript, Codex App Server, SQLite, Orca CLI, Vitest.

## 공통 제약
한국어 응답. 기존 Codex 구독 인증. 보호 로드맵 접근 금지. 사용자 변경 유지. 서비스 중복 방지 유지. CI와 테스트 시 ORCA_HQ_SKIP_GLOBAL_CLI=1.

### 1. 세션 transport
파일: apps/gateway/src/codex-session.ts, test/codex-session.test.ts.
인터페이스: createCodexSessionClient({cwd,instructions,tools,timeoutMs?}); run({threadId?,text,onThread,onTool}): Promise<{threadId,text}>; close(). Tool spec={name,description,inputSchema}; onTool(name,args,callId):Promise<unknown>.
- [x] fake stdio server로 thread 재개, 여러 도구 왕복, 최종 자연어, 오류·timeout·종료 테스트를 먼저 작성하고 실패 확인.
- [x] installed protocol에 맞는 JSON RPC client 구현, 외부 도구/승인 요청 차단, read-only sandbox.
- [x] focused test/typecheck; 실제 Codex smoke.

### 2. Orca 도구
파일: apps/gateway/src/agent-tools.ts, test/agent-tools.test.ts.
인터페이스: createAgentTools({catalog,execute,locations,invoke?}); specs; call(name,args,input):Promise<ManagedCommandResult|unknown>.
- [x] GH와 scsms를 동시에 탐색하고 workspace 단서로 좁히는 테스트 먼저 작성.
- [x] native 조회 schema와 보호 경계, 기존 relay mutation 전달, 경로 제안/확인 연동 구현.
- [x] argv 검증·scope·redaction·복수 mutation request ID 테스트.

### 3. 대화와 런타임 통합
파일: agent-conversation.ts, managed-runtime.ts, installer control.ts와 테스트.
- [x] 영속 thread mapping, /new, 재시작 복구, 동일 세션 직렬화, 이전 기록 이관 테스트 먼저 작성.
- [x] Codex에 원문 전달, tool 결과에 따라 자연어 답변, 유한 timeout, 다중 job watcher 연결.
- [x] 전체 test/typecheck/build, 독립 코드 리뷰, 설치본 명시 파일 반영 및 실제 GH 대화 재현.
- [ ] 개인 Slack에서 사용자 메시지 왕복 최종 확인.

## 검증 기록

2026-09-07: 69 files / 923 tests, 전체 typecheck, 전체 build 통과. 실제 Codex dynamic tool 호출과 새 프로세스 resume 문맥 유지 확인. GH folder workspace의 법령개정이력 터미널을 조회하여 수정·검증·미커밋 상태 요약 성공. 설치본 반영과 doctor 14 pass / voice 1 skip / fail 0 확인. 보호 로드맵 미접근.

후속 보완: 전역 작업 목록 갱신이 대화 deadline을 소모한 실제 사례를 확인하여, 대화의 jobs.list는 최근 20개 저장 snapshot을 시점 표시와 함께 제공한다. 특정 작업의 현재 상태는 native 조회로 확인한다. 조회 CLI에는 SIGKILL timeout을 적용한다.
