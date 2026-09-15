# HQ Native Orca 작업 인계

작성일: 2026-09-09 · Task 4 갱신: 2026-09-15
목적: 다음 세션에서 별도 재분석 없이 현재 구현 상태를 복원하고 작업을 이어간다.

## 현재 기준점

- 기준 브랜치: `main`
- 완료된 구현: 계획의 **Task 1~4** (Task 4 순차 독립 리뷰 완료, 5개 지적 사항 모두 수정됨)
- 다음 구현: **Task 5 — 실제 native worker 표시와 설정 UX**, Task 4 리뷰 이후 진행
- 실제 설치본(`/Users/j.jaeyo/Applications/orca-hq`)에는 아직 통합하지 않았다.
- 과거 검증 기준점 `86e3845`는 이전 세션에서 `pnpm typecheck`, 1165개 테스트, `pnpm -r build`를 이미 통과했다. 기존 인계의 전체 검증·커밋 미실행 주장은 그 이전 시점의 오래된 기록이었다.
- 이번 Task 4에서는 설치·서비스 재시작·새 빌드·커밋·푸시를 수행하지 않았다. 아래의 Task 4 테스트 결과는 새 검증이며 위 기준점 결과와 구분한다.

## 완료된 범위

1. `packages/core/src/native-work.ts`와 gateway planner에 native 실행 계약, profile allowlist, 의존성 DAG 검증을 추가했다.
2. `apps/gateway/src/worker-admission.ts`에 SQLite 기반 전역 worker admission을 추가했다. 기본값은 10이며 양의 safe integer 또는 `"unlimited"`를 지원한다. 재시작 복구, FIFO, 자원 점유, coordinator epoch fencing을 포함한다.
3. `apps/gateway/src/native-launch.ts`와 relay 변경으로 agent/model/worktree를 명시한 Orca worker-start, launch journal, 응답 유실 복구, 안전한 terminal 재사용 검증을 추가했다.

4. `native-coordinator.ts`와 같은 SQLite 연결의 `native-journal.ts`를 추가하고 managed runtime, progress runtime, commands/tools, relay를 native admission에 연결했다. Delivery 단계, 질문/답변, 후속 지시, fanout, 결과 재조정과 cleanup/ack 재진입을 포함한다.
5. `GATEWAY_EXTERNAL_ADAPTERS` 경로는 조회 기능을 유지하며 shared admission 밖의 root/verifier/fix/retry 실행을 `native_admission_required`로 차단한다.

관련 근거 문서:

- [설계](../specs/2026-09-08-hq-native-orca-agents-design.md)
- [전체 계획](../plans/2026-09-08-hq-native-orca-agents.md)
- [Task 1 결과](2026-09-08-native-orca-task1-result.md)
- [Task 2 결과](2026-09-08-native-orca-task2-result.md)
- [Task 3 결과](2026-09-08-native-orca-task3-result.md)
- [Task 4 결과](2026-09-15-native-orca-task4-result.md)
- [구현 상태](2026-09-08-native-orca-implementation-status.md)

## 검증된 범위

- Task 1 집중 테스트: 48개 통과
- Task 2 집중 테스트: 62개 통과
- Task 3 집중 테스트: 108개 통과
- root source-alias TypeScript 검사와 관련 diff whitespace 검사를 통과했다.
- Task 4 집중 검증: 11개 파일 / **188개 테스트 통과**.
- Task 4 새 검증: **`pnpm typecheck` 통과**, **`pnpm test` 91개 파일 / 1191개 테스트 통과**.
- Task 4 순차 독립 리뷰(`2026-09-15-native-orca-task4-review.md`)의 blocker 1건과 후속 4건을 2차 패스에서 모두 수정했다: 잘못된 worker 메시지는 메시지 단위로 사유와 함께 durable quarantine되어 전체 delivery 루프를 막지 않고 해당 워커의 슬롯도 풀지 않는다, 재시작은 정확히 소유한 Dispatch의 실시간 확인이 있을 때만 guidance를 복원한다(후속 보정: PTY 연결은 agent 생존 증거가 아니다. `worker-show`의 `observation.status`는 PTY 생존이고 권위 있는 agent 판정은 `worker-list`의 `projection.liveness`이므로, 정확한 소유 행의 `verdict`가 `live`일 때만 재활성화하고 `exited`/`unverifiable`/판정 부재/행 부재는 보수적으로 unknown을 유지한다. `orca-relay.test.ts`에 전용 fixture 테스트를 추가했다), 선언된 read-only scope는 project alias를 거쳐 정규 id로 해석되고 불일치 시 write로 넓히지 않고 실패한다, no-conversation-execution 인수 테스트는 실제 실행 라우터를 통과한다, `HQ_MAX_ACTIVE_WORKERS`는 변수명과 허용 값을 알려주는 오류로 검증된다. 리뷰 문서에 항목별 해소 내역과 근거 있는 부분 이견 1건을 기록했다.
- Task 4 새 `pnpm -r build`는 실행하지 않았다. 위 `86e3845` 빌드는 과거 검증 근거다.
- 실제 HQ endpoint에서 native Task/Dispatch가 동작하는지, 새 terminal이 GUI에 표시되는지는 아직 검증하지 않았다.

## 다음 세션 실행 순서

1. Task 4 순차 독립 리뷰와 그 5개 지적 사항 수정은 완료되었다. 남은 확인은 리뷰 문서의 **Review resolutions** 절과 결과 문서의 **Review fixes** 절을 읽는 것으로 충분하다.
2. Task 5를 한 번에 하나의 Orca worker로 진행한다. Task 4의 UI/config 파일 작업을 미리 수행하지 않았다. quarantine 기록을 운영자에게 보여주는 표면은 Task 5 범위로 남아 있다.
3. Task 5는 실제 worker 신원·상태 표시, 일반 설정 파일의 worker limit/profile/retention, HQ terminal UX를 담당한다.
4. Task 6~7에서 migration 및 실제 HQ endpoint/GUI·설치 준비 검증을 수행한다. 별도 승인 없이 설치본 변경·서비스 재시작을 하지 않는다.

Task 4 검증 재현:

```bash
pnpm exec vitest run \
  apps/gateway/test/native-coordinator.test.ts \
  apps/gateway/test/managed-runtime.test.ts \
  apps/gateway/test/progress-runtime.test.ts \
  apps/gateway/test/relay-coordinator.test.ts \
  apps/gateway/test/managed-commands.test.ts \
  apps/gateway/test/orca-relay.test.ts \
  apps/gateway/test/agent-tools.test.ts \
  apps/gateway/test/entry.test.ts \
  apps/gateway/test/worker-admission.test.ts \
  apps/gateway/test/progress-store.test.ts \
  apps/gateway/test/native-launch.test.ts
pnpm typecheck
pnpm test
```

구현 기본 정책은 primary retain / fanout child release다. 이번 coordinator가 구현 판단으로 선택했으며 이전 사용자 선호 확인으로 기록하지 않는다. 시작 시 `HQ_MAX_ACTIVE_WORKERS`를 생략하면 10이고 양의 safe integer 또는 `unlimited`를 지원한다. 일반 설정 파일 연결은 Task 5에 남아 있다. CLI 1.4.199의 camelCase worker receipt를 read-only 검사로 확인하고 이전 snake_case와 함께 처리하도록 보완했다.

## 운영·안전 제약

- 다음 파일은 어떤 사본에서도 읽기·hash·diff·stage·restore·수정하지 않는다: `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`.
- 기존 공유 변경 사항을 되돌리지 않는다. 병렬 worktree를 만들지 않는다.
- 한 번에 Task 하나, Orca worker 하나만 실행한다. 일반 subagent로 대체하지 않는다.
- 설치·재시작·외부 채널 메시지는 해당 단계가 명시적으로 승인된 뒤 수행한다.
- 응답 유실이나 상태 불명인 attempt는 자동 재실행하지 않고 점유를 유지한다.
- 기본 active worker 수 10은 초기 운영 설정이며 고정 상한이 아니다. `"unlimited"`에서도 자원 충돌·소유권·중복 방지는 유지한다.

