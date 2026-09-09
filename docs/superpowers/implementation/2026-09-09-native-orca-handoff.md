# HQ Native Orca 작업 인계

작성일: 2026-09-09  
목적: 다음 세션에서 별도 재분석 없이 현재 구현 상태를 복원하고 작업을 이어간다.

## 현재 기준점

- 기준 브랜치: `main`
- 완료된 구현: 계획의 Task 1~3
- 다음 구현: **Task 4 — native-first runtime과 durable Delivery loop 연결**
- 실제 설치본(`/Users/j.jaeyo/Applications/orca-hq`)에는 아직 통합하지 않았다.
- 서비스 재시작, 전체 빌드, 전체 테스트, 커밋·푸시는 이 인계 시점까지 수행하지 않았다.

## 완료된 범위

1. `packages/core/src/native-work.ts`와 gateway planner에 native 실행 계약, profile allowlist, 의존성 DAG 검증을 추가했다.
2. `apps/gateway/src/worker-admission.ts`에 SQLite 기반 전역 worker admission을 추가했다. 기본값은 10이며 양의 safe integer 또는 `"unlimited"`를 지원한다. 재시작 복구, FIFO, 자원 점유, coordinator epoch fencing을 포함한다.
3. `apps/gateway/src/native-launch.ts`와 relay 변경으로 agent/model/worktree를 명시한 Orca worker-start, launch journal, 응답 유실 복구, 안전한 terminal 재사용 검증을 추가했다.

관련 근거 문서:

- [설계](../specs/2026-09-08-hq-native-orca-agents-design.md)
- [전체 계획](../plans/2026-09-08-hq-native-orca-agents.md)
- [Task 1 결과](2026-09-08-native-orca-task1-result.md)
- [Task 2 결과](2026-09-08-native-orca-task2-result.md)
- [Task 3 결과](2026-09-08-native-orca-task3-result.md)
- [구현 상태](2026-09-08-native-orca-implementation-status.md)

## 검증된 범위

- Task 1 집중 테스트: 48개 통과
- Task 2 집중 테스트: 62개 통과
- Task 3 집중 테스트: 108개 통과
- root source-alias TypeScript 검사와 관련 diff whitespace 검사를 통과했다.
- 아직 전체 `pnpm test`, `pnpm typecheck`, `pnpm -r build`를 새 변경 전체에 대해 실행하지 않았다.
- 실제 HQ endpoint에서 native Task/Dispatch가 동작하는지, 새 terminal이 GUI에 표시되는지는 아직 검증하지 않았다.

## 다음 세션 실행 순서

1. 변경 상태와 이 문서를 읽고 Task 4 범위를 확인한다.
2. Orca orchestration으로 **Run → Task → Dispatch → worker-start**를 사용해 Task 4를 한 번에 하나의 worker로 수행한다.
3. `native-coordinator.ts`를 추가하고 `managed-runtime.ts`, `progress-runtime.ts`, `relay-coordinator.ts`를 shared admission에 연결한다.
4. `conversation.execute` 우회 방지, durable Delivery 단계(received/applied/cleanup_pending/acknowledged), same-context followup, fanout DAG, stale completion, 질문 재연결을 집중 테스트한다.
5. Task 4~6이 끝난 뒤에만 설치본 백업, build artifact 설치, 서비스 재시작, 실제 endpoint 검증을 수행한다.

재개에 사용할 집중 테스트의 출발점:

```bash
pnpm exec vitest run \
  apps/gateway/test/native-coordinator.test.ts \
  apps/gateway/test/managed-runtime.test.ts \
  apps/gateway/test/progress-runtime.test.ts \
  apps/gateway/test/relay-coordinator.test.ts \
  apps/gateway/test/managed-commands.test.ts
```

## 운영·안전 제약

- 다음 파일은 어떤 사본에서도 읽기·hash·diff·stage·restore·수정하지 않는다: `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`.
- 기존 공유 변경 사항을 되돌리지 않는다. 병렬 worktree를 만들지 않는다.
- 한 번에 Task 하나, Orca worker 하나만 실행한다. 일반 subagent로 대체하지 않는다.
- 설치·재시작·외부 채널 메시지는 해당 단계가 명시적으로 승인된 뒤 수행한다.
- 응답 유실이나 상태 불명인 attempt는 자동 재실행하지 않고 점유를 유지한다.
- 기본 active worker 수 10은 초기 운영 설정이며 고정 상한이 아니다. `"unlimited"`에서도 자원 충돌·소유권·중복 방지는 유지한다.

