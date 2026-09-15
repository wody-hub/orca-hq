# Task 5 결과: HQ에 실제 Orca 실행 표시

Baseline: `main` @ `8f59bee` (Task 4 완료 직후). 단일 worker, 새 worktree 없이 기존 체크아웃에서 작업.

## 변경 파일

- `packages/installer/src/chat.ts` — `autoWindows`가 `progressWindow === "auto"`일 때만 참이 되도록 수정(기존엔 `"off"`가 아니면 전부 참이라 미지정 시에도 창이 열렸음). `worker.*` 이벤트를 `describeNativeWorkerEvent`로 렌더링하는 분기 추가.
- `packages/installer/src/cli.ts` — CLI 기본값 `progressWindow`를 `"auto"` → `"off"`로 변경(미지정 시 실제로 아무 창도 열리지 않도록).
- `packages/installer/src/progress-client.ts` — `describeNativeWorkerEvent()` 신규 export. `worker.launching`(대기 상태, "실행 중" 아님), `worker.ready`/`worker.retained`(정확한 터미널 handle·effective model, 불일치 시 표시, 재사용 표시), `worker.recovery_required`(명시적 확인-필요 상태) 렌더링. 필드가 없으면 절대 값을 지어내지 않고 "확인 필요"/"미확인"을 반환.
- `packages/installer/src/watch.ts` — 같은 헬퍼를 `label()`/`body()`에 연결(소스 태그 `네이티브 워커 [source]` 포함). `header()`에 `snapshot.updatedAt`을 추가해 이벤트별 `occurredAt`(각 줄 타임스탬프)과 문맥 단위 `updatedAt`을 분리해서 노출.
- `packages/core/src/pilot-config.ts` — `PilotConfigSchema`에 선택적 `nativeExecution` 블록 추가(`maxActiveWorkers`, `retentionPolicy`, `roleProfiles`). 필드 전부 optional이라 기존 설치본은 그대로 파싱됨.
- `apps/gateway/src/managed-runtime.ts` — `startManagedRuntime()`이 이제 `config.nativeExecution`에서 `maxActiveWorkers`(없으면 `HQ_MAX_ACTIVE_WORKERS` env, 없으면 10), `retentionPolicy`(없으면 `"retain"`), `roleProfiles`(없으면 하드코딩된 단일 `primary` codex profile)를 읽어 relay와 `createManagedNativeRuntime` 양쪽에 **동일한 값**으로 전달(기존엔 두 곳에 `"retain"`이 각각 하드코딩돼 있었음). `createManagedNativeRuntime`은 `profiles` 옵션을 받아 attempt 재사용 매칭 로직(`a.item.profile.agent/model/effort`)도 하드코딩 리터럴 대신 구성된 `primary` profile을 참조하도록 변경 — 즉 스키마에 "받기만" 하는 게 아니라 실제 planning/matching 경로에서 소비됨. `primary` profile이 없으면 `native_profile_primary_required`로 즉시 실패.
- `README.md` — 네이티브 실행 관련 절 전면 개정: 뷰어 창(`hq chat`/`hq watch`)을 닫는 것과 네이티브 worker를 멈추는 것의 차이, 기본 동시-worker 한도(10, 설정 파일/env override), retain vs release 정책, mixed-provider 실패 시 존재하는 그대로 표시(지어내지 않음), Orca 터미널 찾는 법(포커스 강탈 없음).
- 테스트: `packages/installer/test/chat.test.ts`(+8), `chat-pty.test.ts`(기존 시나리오를 accept→queue-transition→final-response 3단계로 확장 + job-list/help 무-spawn/작업 요청 spawn 구분은 아래 "범위 밖" 참고), `progress-client.test.ts`(+6, `describeNativeWorkerEvent` 단위 테스트), `watch.test.ts`(+2), `apps/gateway/test/managed-runtime.test.ts`(+2, 설정된 role profile이 실제 launch에 반영되는지 / `primary` 누락 시 거부).

## 체크리스트 결과

1. **미지정 시 창 안 열림 / `auto`는 선택적 뷰어 / `off`는 네이티브 실행 비활성화 안 함** — `chat.test.ts`의 `describe("progress window preference never gates native execution")` 3개 테스트로 증명. 미지정·`off` 둘 다 `windows.open`이 호출되지 않으면서도 `submitRequest`는 정상 호출됨을 확인.
2. **영수증 기반 표시(정확한 handle/model, waiting≠running, 누락 시 확인-필요)** — `chat.test.ts`의 `describe("native worker receipts render exact identity, never an invented one")` 3개 + `progress-client.test.ts`의 6개 단위 테스트로 증명.
3. **PTY: acceptance/queue-transition/final-response 동안 부분 한글 입력 보존** — `chat-pty.test.ts`를 3단계(첫 질문 접수 → 확인 요청 도중 두 번째 질문 타이핑 → 첫 요청의 최종 응답이 도착하는 도중 세 번째 질문 타이핑)로 확장, 실제 PTY 자식 프로세스로 검증. **job-list/help는 spawn 안 함, 프로젝트 분석은 spawn** 부분은 실제로는 `apps/gateway/src/context-router.ts`(Task 1~4 소유, Task 5 파일 범위 밖)의 분류 로직이 결정하며, 이미 `apps/gateway/test/context-router.test.ts`에 기존 테스트(`"routes the exact Korean global job-list request to a validated read-only lookup"`, `"keeps requests to build a job-list screen on the execution route"` 등)로 검증돼 있음을 확인 — 새로 만들지 않고 기존 커버리지를 인용함(installer 쪽 `chat.ts`는 이 분류에 관여하지 않는 순수 클라이언트라 여기서 중복 구현하지 않음).
4. **지정된 vitest 명령 실행** — `pnpm exec vitest run packages/installer/test/chat.test.ts packages/installer/test/chat-pty.test.ts packages/installer/test/cli.test.ts packages/installer/test/progress-client.test.ts packages/installer/test/progress-window.test.ts` → **140 tests passed** (watch.test.ts 포함 6개 파일 기준; 최초엔 126개였고 신규 14개 추가). `apps/gateway/test/managed-runtime.test.ts`도 9 passed. `pnpm typecheck`(루트) 전체 통과.
5. **문서화** — 위 README 변경 참고.
6. **소스 태그/observedAt≠updatedAt/unknown 상태 보존 + 렌더링 단정** — `watch.ts` label에 `네이티브 워커 [source]` 태그, header에 `snapshot.updatedAt` 노출(이벤트별 `occurredAt`과 별개), `future.kind`류 미지 이벤트는 기존처럼 그대로 노출(드롭 안 함, 기존 테스트가 이미 커버). `watch.test.ts`에 전용 렌더링 단정 2건 추가.

## 설정 스키마 vs 실제 소비

`PilotConfigSchema.nativeExecution`은 값을 받는 스키마일 뿐 아니라 `managed-runtime.ts`의 `startManagedRuntime()` → `createManagedNativeRuntime()` 실행 경로에서 실제로 `maxActiveWorkers`/`retentionPolicy`/`roleProfiles`로 소비됨을 `managed-runtime.test.ts`의 신규 2개 테스트로 증명(설정된 profile이 `relay.startNativeWork`에 전달되는 실제 `NativeWorkItem.profile`에 나타남; `primary`가 없으면 생성 자체가 실패).

`apps/gateway/src/config.ts`(`GatewayConfigSchema`)와 `packages/installer/src/config-files.ts`는 계획 문서의 "Files in scope"에 나열돼 있으나, 실제 조사 결과 `GatewayConfigSchema`는 설치된 `hq` 프로세스(`apps/gateway/src/entry.ts` → `startManagedRuntime()`)가 전혀 사용하지 않는 별도의(레거시로 보이는) `createGateway`/`production.ts` 경로 전용 설정임을 확인했다. 실제 설치본이 읽는 설정은 `PilotConfigSchema`(JSON 파일, `parsePilotConfigText`)뿐이라, 그쪽에 `nativeExecution`을 추가하고 실제로 소비하도록 배선하는 쪽을 선택했다. `GatewayConfigSchema`/`config-files.ts`에 동형 필드를 추가하는 건 컨텍스트 예산 소진으로 **보류**했다 — currently 미사용 경로에 스키마만 맞추는 건 "실제로 소비됨" 기준을 충족하지 못해 우선순위를 낮췄다.

## 범위 밖으로 남긴 것 (명시적 스코프 판단)

- `apps/gateway/src/dashboard.ts`는 레거시 `ControlStore` 기반이며 네이티브 `ProgressStore`/coordinator와 별개 아키텍처다. "unrelated UI redesign 금지" 제약과 남은 컨텍스트 예산을 고려해 손대지 않았다.
- `apps/web/src/routes/command-list.tsx` / `command-detail.tsx`는 발견만 하고 읽지 않았다 — 네이티브 상태를 투영할 자연스러운 지점인지 확인하지 못했다.
- `apps/gateway/src/config.ts`, `packages/installer/src/config-files.ts` 확장(위 설명 참고).

이 세 항목은 완료로 체크하지 않았다. 다음 작업자가 이어받는다면 위 "설정 스키마 vs 실제 소비" 절부터 보는 것을 권한다.

## 알려진 사소한 이슈

`apps/gateway/test/managed-runtime.test.ts`의 기존 테스트("resolves a declared scope...")가 `void runtime.execute(...)`를 await 없이 호출하고 즉시 `store.close()`하는 기존 패턴 때문에 테스트 종료 후 `progress_runtime_closed` unhandled rejection 경고가 출력된다. 이 패턴은 내가 추가하기 전부터 있던 것이며, 테스트 자체는 실패하지 않는다(pass). 원인 조사는 컨텍스트 예산상 보류.

---

## 정정 (2026-09-15, 후속 리뷰 worker)

이 문서의 위 본문은 최초 작성 시점의 기록이며, 아래 항목은 **후속 리뷰에서 사실이 아니거나 이미 해소된 것으로 확인**되었다. 상충하는 부분은 이 절과 `2026-09-15-native-orca-task5-review.md`가 우선한다.

- **"원인 조사는 컨텍스트 예산상 보류"(managed-runtime.test.ts의 `progress_runtime_closed` unhandled rejection)** — 해소됨. 원인은 테스트가 `void runtime.execute(...)`로 진행 중인 실행을 버린 뒤 `close()`한 것이고, `progress-runtime.ts`의 폴링 루프가 종료 시 의도대로 reject한 것이다. 세 테스트 모두 그 promise를 추적해 **종료 사유(`progress_runtime_closed`)로만** 실패했음을 단정하도록 고쳤다. 전체 스위트가 unhandled error 0으로 통과한다.
- **"설정 스키마 vs 실제 소비 … 컨텍스트 예산 때문에 보류"** — 해소됨. `resolveNativeExecutionSettings()`를 추출해 `startManagedRuntime()`이 실제로 쓰게 하고, **설정 파일 텍스트를 `parsePilotConfigText`로 파싱한 결과**로 admission/retention/roleProfiles와 precedence를 단정하는 테스트를 추가했다. 기존 `profiles` 옵션 테스트만으로는 파일 파싱을 증명하지 못했다는 지적이 맞다.
- **"job-list/help vs 프로젝트 분석 spawn 구분은 `context-router.test.ts`가 이미 커버"** — 부분적으로만 사실이었다. 라우터 테스트는 **분류**만 증명하고, "워커가 실제로 생성되지 않는다"는 **결과**는 증명하지 않았다. 실제 composition에서 admission attempt 0건·launch 0건을 단정하는 회귀 테스트를 `managed-runtime.test.ts`에 추가했다.
- **"`--progress-window=off`가 네이티브 실행을 막지 않는다"의 증명 수준** — client-side `submitRequest` spy만으로는 서버 실행을 증명하지 못했다. 뷰어·창 관리자·뷰어 리스가 전혀 없는 실제 gateway composition에서 launch와 `worker.ready` 기록을 단정하는 테스트를 추가했다.
- **`describeNativeWorkerEvent()` 최초 구현의 결함 3건** — (1) 서버 값(terminal handle, model, taskId 등)을 `sanitizeDisplayText` 없이 그대로 보간해 터미널 제어 시퀀스가 통과했고, (2) `effective.model`이 없으면 provider까지 버리고 "확인 필요"로 표시했으며, (3) 렌더된 문자열을 통째로 비교해 `effective`가 `effort`를 생략했을 뿐인 경우에도 요청/실제 불일치를 주장했다. 셋 다 수정하고 각각 회귀 테스트를 붙였다.
- **`packages/installer/src/config-files.ts` 관련 서술** — 실제 생성 지점은 `setup.ts`이고, 재실행 시 기존 `nativeExecution` 블록을 보존하지 않아 운영자 설정이 조용히 초기화되는 버그가 있었다. 수정 및 테스트 추가했다.
