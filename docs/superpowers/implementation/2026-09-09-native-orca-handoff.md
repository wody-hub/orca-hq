# HQ Native Orca 작업 인계

작성일: 2026-09-09 · Task 4~6 및 production install 갱신: 2026-09-15
목적: 다음 세션에서 별도 재분석 없이 현재 구현 상태를 복원하고 작업을 이어간다.

## 현재 기준점

- 기준 브랜치: `main`, HEAD `a98e43f`이다. Task 5/6은 `2abf515`로 커밋했고, Orca 1.4.201의
  nullable terminal title 호환 수정은 `a98e43f`로 별도 커밋했다.
- 완료된 구현: 계획의 **Task 1~6** (Task 4 순차 독립 리뷰 완료 및 수정 반영, Task 5는 선행 worker
  구현 + 독립 리뷰 worker의 결함 수정까지 완료됨). 상세는
  [Task 5 결과](2026-09-15-native-orca-task5-result.md)와
  [Task 5 리뷰](2026-09-15-native-orca-task5-review.md)를 참조한다.
- `a98e43f`의 15개 package/app dist tree는 실제 설치본
  (`/Users/j.jaeyo/Applications/orca-hq`)에 byte-identical하게 설치됐다. launchd gateway는 PID
  31689로 running이고 `/health` 200, `hq jobs list` exit 0, recovery barrier ready=1, DB 무결성,
  기존 3개 legacy assignment identity 보존을 확인했다. 전체 근거와 rollback은
  [production installation result](2026-09-15-native-orca-installation-result.md)에 있다.
- 다음 구현: **Task 7**(full live native/GUI/10+1 수용 검사). Task 5 리뷰 문서의
  "남은 범위" 절 — 레거시 웹 UI 배선, 다중 뷰어 리스 모델, sanitization 공용화 — 는 별도 범위다.
- 과거 검증 기준점 `86e3845`는 이전 세션에서 `pnpm typecheck`, 1165개 테스트, `pnpm -r build`를 이미 통과했다. 기존 인계의 전체 검증·커밋 미실행 주장은 그 이전 시점의 오래된 기록이었다.
- 이번 release에서 Task 5/6 commit·production install·HQ-only restart를 수행했다. push와 외부
  채널 전송은 하지 않았다. Task 6의 기존 검증과 이번 live health 증거는 서로 구분한다.

## 실제 설치·소비 경로 (범위 오인 방지)

- 실제로 설치되어 동작하는 실행 경로는 `apps/gateway/src/entry.ts` → `startManagedRuntime()` →
  `PilotConfigSchema`(`packages/core/src/pilot-config.ts`) + `managed-runtime.ts`이다. Task 5는
  이 경로에 native worker 설정(`maxActiveWorkers`/`roleProfiles`/retention)과 표시
  (`describeNativeWorkerEvent`, `chat.ts`/`watch.ts` 공유)를 배선했다.
- `apps/gateway/src/config.ts`의 `GatewayConfigSchema`, 레거시 `ControlStore`, `apps/web`의
  `dashboard.ts`/`command-*.tsx` 경로는 **현재 비활성인 별도 composition**이다. Task 5는 이 경로에
  같은 필드를 추가하지 않았고, 여기 구현했다고 서술하지 않는다.
- **quarantine 기록의 운영자 표면**(잘못된 worker 메시지를 durable quarantine한 기록을 보여주는
  화면)은 Task 4 리뷰에서 남은 항목으로 지목됐고 Task 5 범위로 옮겨졌지만, Task 5 결과·리뷰
  문서 어디에도 구현 기록이 없다 — **여전히 미구현**이며, 별도의 모니터링/운영자 기능으로 남아
  있다.
- 웹 모니터링 실현 가능성은 Task 5 리뷰 문서에 코드 기반 평가로만 기록돼 있다(구현 아님): HQ는
  이미 v1 `/v1/progress` API(제출·문맥 목록·NDJSON 스트림)와 append-only 이벤트 로그를 제공하므로
  **읽기 전용·단일 관찰자** 웹 모니터의 기반은 있다. 다만 "프런트엔드 작업만으로 충분하다"는 결론은
  과장이다 — (1) 뷰어 리스가 문맥당 1개라 다중 관찰자(웹 + 기존 `hq watch`를 동시에)를 지원하려면
  gateway 쪽에 리스 없는 새 구독 경로를 **백엔드로 설계·구현**해야 하고, (2) sanitization이
  `packages/installer` 쪽에만 있어 공유 패키지 경계를 새로 정해야 하며, (3) `apps/web`은 지금 이
  API를 읽지 않는다. 이 셋 다 아직 아무것도 만들어지지 않았다. 또한 HQ progress API는 relay가
  돌려준 워커 신원/보고만 가지고 있을 뿐, 바깥 개발자 Orca Run 내부의 전체 대화·도구 호출
  타임라인은 별도 Orca Run 조회 브리지 없이는 웹에서 볼 수 없다. 이 저장소에는 아직 그 경로가 없다.

## 완료된 범위

1. `packages/core/src/native-work.ts`와 gateway planner에 native 실행 계약, profile allowlist, 의존성 DAG 검증을 추가했다.
2. `apps/gateway/src/worker-admission.ts`에 SQLite 기반 전역 worker admission을 추가했다. 기본값은 10이며 양의 safe integer 또는 `"unlimited"`를 지원한다. 재시작 복구, FIFO, 자원 점유, coordinator epoch fencing을 포함한다.
3. `apps/gateway/src/native-launch.ts`와 relay 변경으로 agent/model/worktree를 명시한 Orca worker-start, launch journal, 응답 유실 복구, 안전한 terminal 재사용 검증을 추가했다.

4. `native-coordinator.ts`와 같은 SQLite 연결의 `native-journal.ts`를 추가하고 managed runtime, progress runtime, commands/tools, relay를 native admission에 연결했다. Delivery 단계, 질문/답변, 후속 지시, fanout, 결과 재조정과 cleanup/ack 재진입을 포함한다.
5. `GATEWAY_EXTERNAL_ADAPTERS` 경로는 조회 기능을 유지하며 shared admission 밖의 root/verifier/fix/retry 실행을 `native_admission_required`로 차단한다.
6. Task 5: 설치된 `PilotConfigSchema`에 native worker 설정(`maxActiveWorkers`/`roleProfiles`/retention,
   `.safe()` 정수 검증, `roleProfiles`가 있으면 `primary` 필수)을 배선하고, `startManagedRuntime()`이
   `resolveNativeExecutionSettings()`를 통해 설정 파일 텍스트를 실제로 소비함을 파싱 테스트로 증명했다.
   `chat.ts`/`watch.ts`가 공유하는 `describeNativeWorkerEvent()`로 실제 worker 신원(터미널
   handle/model/profile 불일치 여부)을 sanitize된 형태로 표시한다. `setup.ts`가 재실행 시
   기존 `nativeExecution` 블록을 보존하도록 고쳤다(이전엔 조용히 초기화됐다).
7. Task 6: assignment별 `executionBackend` additive migration과 재시작 복구 장벽을 실제 SQLite로
   검증했다. 격리된 fake relay와 real managed socket으로 두 context, 동일 context 후속 작업,
   retained terminal 재획득, mixed-channel 10+1, 실패, stop, unknown launch, gateway restart를 검증했다.

관련 근거 문서:

- [설계](../specs/2026-09-08-hq-native-orca-agents-design.md)
- [전체 계획](../plans/2026-09-08-hq-native-orca-agents.md)
- [Task 1 결과](2026-09-08-native-orca-task1-result.md)
- [Task 2 결과](2026-09-08-native-orca-task2-result.md)
- [Task 3 결과](2026-09-08-native-orca-task3-result.md)
- [Task 4 결과](2026-09-15-native-orca-task4-result.md)
- [Task 5 결과](2026-09-15-native-orca-task5-result.md)
- [Task 5 리뷰(권위 있는 최신 상태)](2026-09-15-native-orca-task5-review.md)
- [Task 6 결과](2026-09-15-native-orca-task6-result.md)
- [Task 6 마이그레이션/롤백 절차](2026-09-08-native-orca-migration.md)
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
- Task 5 집중 검증: `packages/core/test/pilot-config.test.ts` 7 passed,
  `apps/gateway/test/managed-runtime.test.ts` 10 passed(unhandled error 0),
  `packages/installer/test/progress-client.test.ts` 33 passed,
  `packages/installer/test/setup.test.ts` 5 passed, `pnpm typecheck` 통과.
- Task 5 전체 스위트: `npx vitest run` → **92 files / 1222 tests passed, unhandled error 0**
  (coordinator가 review worker transcript의 2026-09-15 11:33:14 KST 최종 실행을 대조 확인한 수치;
  같은 세션의 이전 실행에서 로그된 1221은 그 이전 중간 카운트로, Task 4의 1191과 함께 과거
  참고치로만 남긴다. 상세는 [Task 5 리뷰](2026-09-15-native-orca-task5-review.md)의 "실행한 검증" 절).
- Task 6 집중 검증: **8 files / 110 tests passed**. `pnpm typecheck` 통과,
  전체 `pnpm test`는 **93 files / 1231 tests passed**. root `prepare`의 global installer를
  실행하지 않고 `pnpm --filter './packages/**' --filter './apps/**' --if-present run build`로
  **15 of 16 workspace projects**의 package/app build를 통과했다.
- 이번 release에서 production install/restart와 `/health`·`hq status`·`hq jobs list`를 검증했다.
  실제 HQ endpoint가 새 native Task/Dispatch를 launch/result까지 처리하는지와 새 terminal의 GUI
  표시는 real project 교란을 피하려 아직 검증하지 않았다.

## 다음 세션 실행 순서

1. Task 4 순차 독립 리뷰와 그 5개 지적 사항 수정은 완료되었다. 남은 확인은 리뷰 문서의 **Review resolutions** 절과 결과 문서의 **Review fixes** 절을 읽는 것으로 충분하다.
2. Task 5(실제 worker 신원·상태 표시, 일반 설정 파일의 worker limit/profile/retention, HQ terminal
   UX)는 선행 worker 구현 + 독립 리뷰 worker의 결함 수정, commit, production install까지 완료됐다.
3. Task 6 migration/복구 및 격리된 native 수용 검사는 완료됐다. 재현 명령과 exact allowlist는
   Task 6 결과 문서를 기준으로 한다.
4. 다음은 **Task 7**이다. 독립 리뷰 후 실제 HQ native launch/result와 GUI·10+1 검증을 수행한다.
   별도 승인 없이 추가 설치본 변경·서비스 재시작을 하지 않는다. Task 5의 레거시 웹/quarantine/다중 viewer/
   sanitization 항목은 Task 7에 자동 포함하지 않는다.

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

구현 기본 정책은 primary retain / fanout child release다. 이번 coordinator가 구현 판단으로 선택했으며 이전 사용자 선호 확인으로 기록하지 않는다. 시작 시 `HQ_MAX_ACTIVE_WORKERS`를 생략하면 10이고 양의 safe integer 또는 `unlimited`를 지원한다. 일반 설정 파일 연결은 Task 5에서 `PilotConfigSchema`/`resolveNativeExecutionSettings()`로 완료됐다(위 참조). CLI 1.4.199의 camelCase worker receipt를 read-only 검사로 확인하고 이전 snake_case와 함께 처리하도록 보완했다.

## 운영·안전 제약

- 다음 파일은 어떤 사본에서도 읽기·hash·diff·stage·restore·수정하지 않는다: `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`.
- 기존 공유 변경 사항을 되돌리지 않는다. 병렬 worktree를 만들지 않는다.
- 한 번에 Task 하나, Orca worker 하나만 실행한다. 일반 subagent로 대체하지 않는다.
- 설치·재시작·외부 채널 메시지는 해당 단계가 명시적으로 승인된 뒤 수행한다.
- 응답 유실이나 상태 불명인 attempt는 자동 재실행하지 않고 점유를 유지한다.
- 기본 active worker 수 10은 초기 운영 설정이며 고정 상한이 아니다. `"unlimited"`에서도 자원 충돌·소유권·중복 방지는 유지한다.
