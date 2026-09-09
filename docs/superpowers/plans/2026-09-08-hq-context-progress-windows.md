# HQ 작업 맥락별 진행 창 구현 계획

상태: Orca Run `run_13fc633f1cf3`에서 구현 및 독립 검토 수정 완료. 최종 자동 검증과 설치 검증은 `../implementation/2026-09-08-progress-verification.md`에 기록한다. 아래 실기 항목 중 미표시는 UI 접근 제한 또는 검증 범위 차이이며 구현 미완료를 뜻하지 않는다.

**목표:** 터미널 지시를 즉시 접수하고 독립 업무를 맥락별 전담 에이전트로 병렬 실행하며, 각각의 별도 창에서 실제 진행 상황을 관찰한다.

**기준 설계:** `../specs/2026-09-08-hq-context-progress-windows-design.md`.

**기술:** Node.js 22, TypeScript, SQLite, Unix domain socket HTTP/NDJSON, 기존 Codex session 및 Orca relay, macOS Terminal/osascript.

## 공통 제약

- 기존 coordinator 복구 변경과 설치본의 추가 대화 기능을 보존한다.
- durable request ID와 기존 실행 receipt를 유지한다. 창 생성·재연결·맥락 표시 정정으로 작업을 재실행하지 않는다.
- 기본 GUI는 macOS Terminal 새 창. 대화형 CLI가 창을 열고 gateway는 GUI를 조작하지 않는다.
- 전역 실행 대기를 맥락별 큐로 바꾸고 독립 업무는 병렬 실행한다. 사용자 결정에 따라 기본 동시 업무 한도는 5개로 확정하고 맥락별 native worker는 최대 1개로 제한한다. HQ 라우터는 업무 슬롯 5개에 포함하지 않는다. HQ 접수·조회·중지는 실행 슬롯과 분리한다.
- 같은 checkout의 read/write·write/write 충돌과 공용 외부 자원 변경은 예약으로 조정한다. lease 만료만으로 기존 편집자가 종료됐다고 판단하지 않는다.
- 사람이 읽는 설계 문서는 실행 테스트 대상이 아니다. 구현 시 각 회귀 테스트를 먼저 실패시킨 뒤 최소 변경으로 통과시킨다.

## 1. 실행 중인 설치본과 저장소의 기능 차이 통합

대상: `apps/gateway/src/{agent-conversation,agent-tools,codex-session,managed-runtime,managed-service,managed-commands,orca-relay}.ts`와 대응 테스트.

- [x] 나열한 파일과 직접 의존 파일의 차이만 조사하여 설치본의 추가 기능·저장소의 coordinator 복구 변경을 목록화한다.
- [x] 설치본의 대화기·도구·Codex session과 테스트를 저장소에 통합한다. 구형 parser로 되돌리지 않는다.
- [x] 기존 대화 재개, 중복 도구 호출, 응답 불명 mutation 차단, native 작업 추적 테스트를 통과시킨다.
- [x] 생산 코드의 기준이 된 파일 목록을 기록하고 이후 설치는 해당 기준에서만 빌드한다.

완료 조건: 깨끗한 빌드에서 현재 설치본과 동등한 대화·진행 콜백·작업 추적 기능 및 coordinator 복구 테스트가 통과한다.

## 2. 공용 계약과 영속 진행 저장소

생성: `packages/core/src/progress.ts`, `apps/gateway/src/progress-store.ts`, `apps/gateway/test/progress-store.test.ts`.
수정: core export 및 명시적 build 파일 목록.

인터페이스:

```ts
type ContextHint = { mode: 'new' | 'continue'; contextId?: string };
type SubmitProgressRequest = { requestId: string; sessionId: string; text: string; contextHint?: ContextHint };
type ContextChoice =
  | { action: 'new'; title: string; objective: string; projectIds: string[]; sourceContextId?: string }
  | { action: 'continue'; contextId: string }
  | { action: 'clarify'; question: string; candidateIds: string[] };
// JSON 입력은 공용 schema로 검증하고 ownerKey는 서버에서 추가한다.
```

- [x] 같은 request ID·같은 본문의 재접수가 한 건이 되는 테스트와 다른 본문이 충돌하는 테스트를 추가한다.
- [x] 설계의 9개 테이블, 접수·이벤트 트랜잭션, eventKey 중복 제거, cursor 조회, snapshot을 구현한다.
- [x] 요청 1개→맥락 여러 개, 맥락 1개→작업 여러 개, 마지막 seq 재개를 검증한다.
- [x] viewer lease의 원자적 예약·만료·토큰 검증, 완료 이벤트 보관 정책을 구현하고 실제 SQLite 동시성 테스트로 검증한다.

완료 조건: 임시 DB 재개 시 동일 요청·이벤트·viewer가 중복되지 않고 오래된 cursor는 snapshot으로 복원된다.

## 3. 비동기 접수와 관찰 프로토콜

생성: `apps/gateway/src/progress-control.ts`, `apps/gateway/test/progress-control.test.ts`.
수정: `managed-control.ts`, `managed-service.ts`.

- [x] 실행기를 지연시켜도 POST가 먼저 202를 반환하는 통합 테스트를 작성한다.
- [x] 설계의 `/v1/progress` 접수·상태·맥락·이벤트·viewer lease 경로를 구현한다. 기존 `/commands` 응답 계약은 유지한다.
- [x] durable queue를 기존 실행 receipt에 안정적인 ID로 연결한다. 프로세스가 접수 후/실행 인계 후/응답 저장 전에 종료되는 경우를 각각 검증한다.
- [x] NDJSON 줄 단위 프레이밍, heartbeat, cursor 재접속, 느린 구독자 분리, 소유자 범위를 테스트한다.

완료 조건: 60초보다 오래 실행되는 가짜 작업도 접수 연결 종료 때문에 재실행되지 않으며 관찰자는 다시 연결할 수 있다.

## 4. 업무 맥락 판정과 실행 대화 분리

생성: `apps/gateway/src/context-router.ts`, `apps/gateway/test/context-router.test.ts`.
수정: `agent-conversation.ts`, `agent-tools.ts`, `managed-runtime.ts`.

- [x] 설계 5절의 예시를 입력·기존 맥락·예상 선택으로 작성한다. 서버 검증 테스트는 구조화된 모델 결과를 주입하고 실제 모델 품질 검증과 분리한다.
- [x] `ContextChoice`를 검증하고 명시 지시→질문 답변→모델 제안 순서로 적용한다. 후보 밖 ID와 모호한 변경 대상은 실행기로 보내지 않는다.
- [x] context별 thread와 라우터 thread를 분리한다. 관련 결과의 요약·출처·시점만 새 맥락에 전달한다.
- [x] `/new`, `/context <ID>`, 복수 대기 질문, 완료 맥락 재개, 여러 업무를 담은 한 지시를 검증한다.
- [x] 실행 시작 후 맥락 정정이 기존 도구 receipt 키를 바꾸거나 같은 mutation을 재전송하지 않는 회귀 테스트를 추가한다.

완료 조건: 같은 프로젝트의 다른 기능은 분리되고, 다른 저장소를 포함한 동일 목적의 업무는 연결될 수 있으며 맥락 혼동이 실행 중복으로 이어지지 않는다.

## 4-B. 맥락별 병렬 에이전트와 자원 예약

생성: `apps/gateway/src/context-executor.ts`, `apps/gateway/src/execution-reservations.ts`, 대응 테스트.
수정: `managed-service.ts`, `agent-conversation.ts`, `codex-session.ts`, `managed-runtime.ts`, `orca-relay.ts`의 실행 진입 경계.

인터페이스:

```ts
type ResourceAccess = { resourceKey: string; mode: 'read' | 'write' };
type ContextExecution = {
  contextId: string; requestId: string; agentId: string;
  generation: number; resources: ResourceAccess[];
};
// 실행기는 맥락별 큐와 전체 업무 슬롯을 관리한다.
// 자원 예약은 외부 프로세스 시작 전에 영속 저장하고 native Dispatch와 연결한다.
```

- [x] A의 모델 응답을 deferred promise로 막은 상태에서 B가 시작·완료하는 테스트를 먼저 작성한다. 동시에 A의 두 번째 turn은 시작하지 않는지 확인한다.
- [x] 전역 `serial`이 접수 뒤의 긴 작업 전체를 감싸지 않도록 실행기를 분리한다. 짧은 DB claim/맥락 확정과 context별 turn 큐는 유지한다.
- [x] 독립 Codex thread·프로세스의 이벤트/도구 콜백을 context/request/agent/generation에 고정한다. 하나의 전역 agent client를 종료하여 다른 업무까지 취소하지 않게 한다.
- [x] 기본 동시 업무 한도 5개, 맥락별 native worker 한도, FIFO 슬롯 배정과 대기 사유를 구현한다. 독립 업무 5개 동시 실행·6번째 대기·슬롯 반환 후 6번째 시작을 테스트한다. 사용자 답변 대기 중이며 native worker도 없는 맥락은 실행 슬롯을 반납한다.
- [x] HQ 라우팅·진행 조회·중지 경로가 실행 슬롯 포화나 한 업무의 지연 때문에 막히지 않는지 검증한다.
- [x] 정규화 checkout/외부 자원의 read/write 예약을 전체 확보 또는 전체 대기로 처리한다. read/read 허용, write 충돌, 다중 자원 교착 방지, 예약 후 worker 시작 응답 유실을 검증한다.
- [x] generation 검증과 native worker 상태 조정을 구현한다. heartbeat 손실만으로 예약을 회수하거나 두 번째 편집자를 시작하지 않는 테스트를 추가한다.
- [x] 실행 중 후속 보완 지시는 기존 Dispatch로 한 번만 전달하고, 목표 변경 지시는 같은 맥락 큐에서 처리한다. 창 재연결과 후속 입력이 새 편집자를 만들지 않음을 검증한다.
- [x] A 중지·실패·재시작이 B의 thread·lease·worker·결과를 바꾸지 않는 장애 격리 테스트를 수행한다.

완료 조건: 서로 독립적인 업무의 실제 실행 구간이 겹치고, 같은 자원을 수정하는 업무는 충돌하지 않으며, HQ 제어 경로는 계속 응답한다. 창 수만으로 병렬 실행 성공을 판단하지 않는다.

## 5. 실제 진행 이벤트 연결

생성: `apps/gateway/src/progress-events.ts`, 대응 테스트.
수정: `codex-session.ts`, `agent-conversation.ts`, `orca-relay.ts`, `managed-runtime.ts`.

- [x] 실제 공개 commentary, 도구 시작·성공·실패, agent 시작·재개·대기, native 작업 연결·상태, 요청 최종 응답을 공용 이벤트 계약에 연결한다. producer의 agent ID와 generation도 기록한다.
- [x] 도구별 허용 필드 요약과 redaction을 적용한다. 원시 인자·응답·터미널 전문을 출력하지 않는다.
- [x] HQ 답변은 끝났지만 worker는 실행 중인 상황, 작업 2개 중 1개만 완료한 상황, retry와 결과 불명 상태를 검증한다.
- [x] polling 이벤트 중복 제거와 연결 실패 시 마지막 관찰 시각 보존을 검증한다.

완료 조건: 이벤트가 원본 동작과 연결되고, 관찰 계층의 실패가 실행 실패나 허위 완료를 만들지 않는다.

## 6. 입력 CLI, watch 렌더러, macOS 창 관리자

생성: `packages/installer/src/{progress-client,watch,progress-window}.ts` 및 대응 테스트.
수정: `chat.ts`, `cli.ts`, 필요한 installer exports.

- [x] `hq chat`에서 durable 접수 뒤 다음 입력을 받을 수 있는 PTY 테스트를 작성한다. 백그라운드 알림이 입력 중인 줄을 지우지 않도록 readline 렌더링을 검증한다.
- [x] `hq watch --context <ID>`의 snapshot+cursor 구독, 단계·시간·연결 상태·요청 구간 표시를 구현한다. Ctrl+C는 구독만 끝낸다.
- [x] `hq chat --progress-window=auto|off`를 제공한다. auto는 대화형 macOS 로컬 입력에서만 창을 연다. off 및 비대화형 입력은 수동 watch 안내를 표시한다.
- [x] viewer lease를 예약한 후 고정 osascript로 Terminal 새 창에서 watch를 실행한다. 사용자 본문·모델 제목을 실행 문자열에 넣지 않는다.
- [x] 중복 열기, 종료한 창 재개, 생성 응답 유실, GUI 권한 거절, 악의적 제어 문자, SSH·pipe 입력을 검증한다.

완료 조건: 같은 맥락에는 살아 있는 진행 창 하나만 있고, 새 업무에는 실제 새 창이 열린다. 창이 없어져도 실행은 유지된다.

## 7. 통합 검증과 출시 준비

- [x] 자동 테스트: 설계 13절의 수용 기준을 각 테스트에 대응시키고 타입 검사·빌드를 통과시킨다.
- [ ] 실제 macOS: 새 창 A→같은 업무 A 재사용→다른 업무 B→A 복귀→A 닫기→후속 요청으로 A 복구를 확인한다.
- [ ] 서로 다른 검증용 업무 A/B를 실제로 동시에 실행하고 이벤트 시각과 native 상태로 실행 구간 중첩을 확인한다. 같은 checkout에 대한 두 수정 요청은 자원 대기가 표시되는지 별도로 확인한다.
- [ ] 실제 접수 시각·맥락 확정 시각·viewer 첫 표시 시각을 측정하고 대기 시간을 보고한다. 모델 분류 latency를 창 렌더링 latency와 분리한다.
- [ ] viewer/gateway/Orca 재시작을 각각 검증한다. 사용자 작업 대신 격리된 검증 대상을 사용하고 기존 worker를 임의 종료하지 않는다.
- [x] Slack·Telegram은 자동 창을 만들지 않는지 자동 테스트로 검증한다. 실제 메시지 발송은 별도 사용자 지시가 있을 때만 수행한다.
- [x] 파일별 백업과 설치본 변경 목록을 만들고 사용자가 승인한 구현 범위에서 설치·실기 검증을 진행한다.

실제 fixture·타입·구현 결과는 팀 계약과 소스·테스트에 반영했다. GUI 버튼 조작을 통한 검증과 단일 실기 환경에서 전체 native worker 경로의 병렬 측정은 완료로 표시하지 않았다. 실제 Codex 5개 병렬 실행, SQLite/소켓 기반 실행기, 실제 PTY·viewer 프로세스는 각각 별도로 검증했으며 범위는 수용 기준 대응표에 명시했다.
