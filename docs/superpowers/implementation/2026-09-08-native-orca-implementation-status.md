# HQ native Orca 구현 여부 확인

> 후속 구현 업데이트: 아래 표는 구현 시작 전 감사 결과다. 이후 Task 1(실행 계약·계획기·native 이벤트 검증)을 구현했고 집중 테스트 48개와 소스 타입 검사를 통과했다. [Task 1 결과](2026-09-08-native-orca-task1-result.md)를 참조한다. 이후 Task 2(지속형 워커 진입 제어·리소스 점유·재시작 복구·코디네이터 소유권 검증)도 구현했고 관련 테스트 62개와 소스 타입 검사를 통과했다. [Task 2 결과](2026-09-08-native-orca-task2-result.md)를 참조한다. 이후 Task 3(명시적 모델·터미널 실행, 실행 기록·복구, 안전한 터미널 재사용)도 구현했고 관련 테스트 108개와 소스 타입 검사를 통과했다. [Task 3 결과](2026-09-08-native-orca-task3-result.md)를 참조한다. Task 4 이후와 운영 설치는 아직 완료되지 않았다.

확인일: 2026-09-08. 기준: 최신 native Orca 설계 및 실행 계획. 동시 실행은 **초기 기본값 10, 양의 안전한 정수 또는 `"unlimited"`로 변경 가능**이라는 사용자 결정을 적용한다.

## 저장소 판정

**새 계획의 완료 기준을 충족한 작업 0개, 기존 기반이 있는 부분 구현 6개, 미구현 1개.** 기존 HQ 전체가 미구현이라는 뜻이 아니다. 새 설계의 핵심 실행 경로와 전역 worker admission은 아직 구현되지 않았다.

| 요구사항 | 현재 구현 | 판정 |
|---|---|---|
| 실무 지시는 반드시 Orca Task/Dispatch로 실행 | `managed-runtime.ts:228`에서 `conversation.execute` 호출 | 새 경로 미구현 |
| 기본 10 / 설정 변경 / unlimited | `context-executor.ts:12`는 기본 5 context, `:45`는 context당 native 하나 | 새 설정·전역 admission 미구현 |
| HQ의 agent/model 선택 | `orca-relay.ts:625`의 Codex 고정 launch | 역할별 모델 선택 미구현 |
| 실제 프로젝트 에이전트 터미널 | 기존 relay의 worker-start 경로는 존재 | 기반 구현, 모든 실무 지시에 적용되지 않음 |
| 완료 터미널 보관·재사용 | 완료 관찰 시 release, 후속 업무는 fresh launch | 새 정책 미구현 |
| HQ 화면에 실제 worker 신원 표시 | context 시작 이벤트와 기본 macOS watch 창 | 새 native 표시 미구현 |
| 중복 방지·자원 예약·실행 중 후속 지시 | 기존 journal, generation, reservation, Dispatch mail | 재사용할 기반 구현 |
| 새 native 흐름의 통합/실환경 검증 | 기존 5-context 및 relay 테스트 | 새 검증 미구현 |

정확한 파일·라인 및 7개 작업별 분류: [source audit](2026-09-08-native-orca-source-status.md). 표의 경로는 gateway source 기준이다.

## 이번 검증

설치 상태 검토에서도 관련 gateway·relay·installer 소스/빌드 파일이 작업 저장소와 byte-identical한 것으로 확인됐다. `hq status`는 running/PID 16888, doctor는 활성 검사 통과를 보고했다. 실제 서비스 실행 경로는 `/Users/j.jaeyo/Applications/orca-hq/apps/gateway/dist/entry.js`다. 즉 현재 설치는 정상 운영 상태지만 새 설계의 구현·설치 완료 상태는 아니다. 단순한 설치 파일 불일치로 설명되지 않는다. [installed audit](2026-09-08-native-orca-installed-status.md)에 비교 파일 목록과 근거가 있다.

이 판정은 코드·설치 파일·서비스 신원과 health를 근거로 한다. 이번 확인에서는 HQ에 업무를 제출하지 않았으므로 실제 endpoint→worker 실행이나 모델 선택 동작을 검증했다고 주장하지 않는다.

부모 coordinator가 2026-09-08 16:49 KST에 실행:

```text
pnpm exec vitest run apps/gateway/test/context-executor.test.ts apps/gateway/test/managed-runtime.test.ts apps/gateway/test/orca-relay.test.ts packages/installer/test/progress-window.test.ts
```

결과: **4 files / 37 tests passed**. 현재 기능의 기준선만 확인한 결과다. 기본 10개의 실제 native worker 동시 실행, 11번째 대기, unlimited, 실제 GUI 표시를 증명하지 않는다. 새 테스트나 운영 작업 요청은 만들지 않았다.

## Orca 오케스트레이션 근거

Run: `run_8bb7664f144b`.

| 검토 | Task | Dispatch | 실제 선택 모델 |
|---|---|---|---|
| 저장소 구현 상태 | `task_3dce8cee343a` | `ctx_bee9b4c1eaff` | Codex gpt-6-astra high |
| 설치본·서비스 상태 | `task_5692318a0b65` | `ctx_ec5b12b0b3ba` | Codex gpt-5.6-sol high |

두 worker-start 응답 모두 현재 HQ checkout의 visible agent terminal 생성 및 input_accepted를 반환했다. 이는 이 검토를 Orca로 수행했다는 근거이며 HQ 제품이 새 설계를 구현했다는 근거가 아니다.

두 검토 Task의 succeeded worker_done을 수신했고, 각각 worker-release로 해당 검토 터미널을 정리했다. 두 transcript는 Orca에 보관됐고 최종 Delivery를 확인·ack했다.

## 다음 구현 순서

기존 기반을 보존하며 계획 Task 1(실행 계약·planner)부터 진행한다. 이후 공통 admission과 명시적 native launch를 구현하고 runtime을 연결한다. UI·migration 뒤에 실제 HQ endpoint와 native worker를 연결한 검증을 수행한다. 이번 작업은 구현 여부 확인 범위이며, 운영 코드 수정·설치·재시작·commit·push·외부 채널 메시지는 하지 않았다.
