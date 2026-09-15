# Task 5 리뷰 및 마무리: HQ에 실제 Orca 실행 표시

Baseline: `main` @ `8f59bee`. 선행 worker의 Task 5 변경을 리뷰하고 결함을 직접 수정한 기록.
선행 worker의 변경은 전부 보존했고, 되돌린 것은 없다. 선행 결과 문서
(`2026-09-15-native-orca-task5-result.md`)의 사실과 다른 서술은 그 문서 말미 "정정" 절에
표시했고, 계획 문서(`2026-09-08-hq-native-orca-agents.md`)의 Task 5 절은 실제 상태로 다시 썼다.

## 확인된 결함과 해소

### 1. 설정 스키마의 입력 검증 구멍 (`packages/core/src/pilot-config.ts`)

- `maxActiveWorkers: z.number().int().positive()`는 **safe integer 범위를 넘는 값**(`1e21`,
  `Number.MAX_SAFE_INTEGER + 1`)을 통과시켰다. 그 값은 `worker-admission.ts:156-158`에서
  `maxActiveWorkers must be a positive safe integer or "unlimited"` 라는 **익명 TypeError**로
  부팅 중에 터진다. `.safe()`를 붙여 설정 파싱 시점에 이름 있는 설정 오류로 실패하게 했다.
  (`null`/소수/0/음수/`"10"` 문자열은 원래도 거부됐고, 이제 회귀 테스트가 붙었다.)
- `roleProfiles`는 선언되면 기본 profile 집합을 **통째로 대체**하는데, `primary` 없는 집합을
  통과시켰다. 그러면 `createManagedNativeRuntime`이 `native_profile_primary_required`로
  부팅 중 크래시한다. 스키마에 `superRefine`을 추가해 `roleProfiles`가 있으면 `primary`를
  요구한다 (`{}`도 거부).
- 증거: `packages/core/test/pilot-config.test.ts` (신규, 7 tests).

### 2. 설정 파일 → 런타임 배선이 테스트로 증명되지 않음 (`apps/gateway/src/managed-runtime.ts`)

선행 테스트는 `createManagedNativeRuntime({ profiles })`에 **직접** 값을 넘겨 확인했는데,
그건 호출자가 넘긴 옵션이 쓰인다는 것만 보이고 **설치본이 읽는 설정 파일**이 그 값을 만든다는
것을 증명하지 못한다.

- `startManagedRuntime()` 안에 흩어져 있던 세 줄을 `resolveNativeExecutionSettings(config, env)`로
  추출하고, `startManagedRuntime()`이 실제로 그 함수를 쓰게 했다. 기본 profile은
  `defaultNativeRoleProfiles`로 export.
- 테스트는 `parsePilotConfigText(JSON.stringify(...))` — 즉 **설치된 설정 파일 텍스트를 파싱한
  결과** — 를 그 함수에 먹여 `maxActiveWorkers`/`retentionPolicy`/`profiles`를 단정한다.
- precedence 확인: 파일 값이 항상 이기고, `HQ_MAX_ACTIVE_WORKERS`는 **파일이 비워 둔 자리에만**
  들어간다. 파일에 값이 있으면 잘못된 env 값이 있어도 부팅을 막지 않는다(반대로, env가 실제로
  쓰이는 경우에는 그대로 검증된다). 뒤집힌 우선순위나 조용한 덮어쓰기는 없다.
- 증거: `apps/gateway/test/managed-runtime.test.ts` — "resolves admission, retention and role
  profiles from the installed config file's own text".

### 3. 포매터의 산출 결함 3건 (`packages/installer/src/progress-client.ts`)

`describeNativeWorkerEvent()`는 신뢰할 수 있는 신원을 보여주는 자리인데:

- **redaction 손실(회귀)** — terminal handle·model·taskId·worktreeId 등 서버 값을
  `sanitizeDisplayText` 없이 그대로 보간했다. `watch.ts`의 `body()`는 원래 모든 텍스트를
  sanitize해서 내보냈으므로, `worker.*` 분기는 기존 보호를 **우회**한 셈이다. 적대적인 handle이
  화면을 지우거나 창 제목을 바꿀 수 있었다. 모든 보간 값을 sanitize하도록 고쳤다.
- **truthfulness: provider를 버림** — 와이어 스키마에서 `effective.model`은 optional인데
  (`packages/core/src/progress.ts`의 `NativeEffectivePayloadSchema`), model이 없으면 profile
  전체를 `"확인 필요"`로 뭉갰다. worker가 실제로 보고한 agent까지 사라진다. 이제
  `codex/모델 미확인`처럼 **보고된 것만** 보여준다.
- **truthfulness: 허위 불일치 주장** — 렌더된 문자열끼리 비교해서, `effective`가 `effort`를
  생략했을 뿐인 흔한 영수증(`{agent, model}`)에도 "요청 …" 불일치 표시를 붙였다. 이제
  worker가 실제로 보고한 필드에 대해서만 불일치를 주장한다.
- `worker.recovery_required`에도 요청 profile을 함께 표시해 "무엇을 확인해야 하는지"가 남게 했다.
- 증거: `packages/installer/test/progress-client.test.ts`에 3건 추가(총 33 tests).

표시 항목 점검: task/dispatch/worktree/terminal/requested/effective 모두 payload의 실제 필드명
(`taskId`/`dispatchId`/`worktreeId`/`terminalHandle`/`requested`/`effective`)에서 읽으며, 없는
필드를 지어내지 않는다. 타임스탬프는 `watch.ts`가 줄마다 `occurredAt`을, header가 문맥 단위
`updatedAt`을 따로 렌더한다(`chat.ts`는 원래 어떤 이벤트에도 타임스탬프를 붙이지 않으므로 유지).
소스 태그 `네이티브 워커 [orca]`도 유지된다.

### 4. 뷰어가 네이티브 실행을 막지 않는다 — 실제 composition으로 증명

선행 증명은 installer 쪽 `submitRequest` spy뿐이라, "서버가 실제로 워커를 띄운다"를 보이지
못했다. `apps/gateway/test/managed-runtime.test.ts`에 실제 composition 테스트를 추가했다:
창 관리자도, watch 프로세스도, 뷰어 리스도 **전혀 없는** 상태에서 `relay.startNativeWork`가
호출되고 `worker.ready` 이벤트가 store에 기록되며, 그 시점에도 문맥의 뷰어 리스가 비어 있어
뒤늦게 붙는 뷰어가 정상적으로 리스를 얻는다.

### 5. job-list/help 무-spawn vs 프로젝트 작업 spawn — 결과까지 증명

`context-router.test.ts`는 **분류**만 증명한다(선행 문서의 인용은 거기까지만 사실). 실제
composition에서 한국어 job-list 요청이 `admission.listAttempts()` 0건 · `startNativeWork` 0회로
답해지고, **같은 런타임**에서 프로젝트 작업 요청은 정확히 1개 워커를 띄우는 회귀 테스트를
추가했다.

### 6. `progress_runtime_closed` unhandled rejection — 원인 규명 및 해소

원인: 테스트가 `void runtime.execute(...)`로 진행 중인 실행을 버리고 곧바로 `close()`한다.
`apps/gateway/src/progress-runtime.ts:1022`의 폴링 루프는 종료 시 의도대로
`progress_runtime_closed`를 던지지만, 버려진 promise라 handler가 없다. 제품 코드의 버그가
아니라 테스트의 promise 관리 문제다. 세 테스트 모두 그 promise를 `abandonedOnShutdown()`으로
추적하고, `finally`에서 **종료 사유로만** 실패했음을 단정한다 — 진짜 실패를 숨기지 않으면서
unhandled rejection이 다른 테스트 파일을 오염시키는 것을 막는다.

### 7. 설치 프로그램이 `nativeExecution`을 조용히 날림 (`packages/installer/src/setup.ts`)

실제 설정 생성 지점은 `config-files.ts`(단순 직렬화)가 아니라 `setup.ts`다. `setup.ts`는 기존
설정에서 `credentialAccounts`/`projectRegistryPath`/`voiceMode`만 이어받고 답변으로 설정을
새로 조립했기 때문에, **`hq setup`을 다시 돌리면 운영자가 넣어둔 `nativeExecution` 블록이
말없이 사라져** worker 한도·retention·role profile이 기본값으로 되돌아갔다. setup은 이 블록을
묻지 않으므로 그대로 보존하도록 고치고, 보존/미생성 양쪽 테스트를 추가했다.

## 범위 조정 (coordinator 승인)

설치된 HQ의 실행 경로는 `apps/gateway/src/entry.ts` → `startManagedRuntime()` →
`PilotConfigSchema` + `managed-runtime.ts`이고, 외부에는 v1 `/v1/progress` API를 제공한다.
계획서의 원래 파일 목록에 있던 `apps/gateway/src/config.ts`(`GatewayConfigSchema`),
`apps/gateway/src/dashboard.ts`, `apps/web/src/routes/command-*.tsx`는 레거시 `ControlStore`
기반의 **현재 비활성 경로**다. 따라서:

- 네이티브 설정은 실제로 소비되는 `PilotConfigSchema`에만 넣었고, 비활성 스키마에 같은 필드를
  **추가하지 않았다**(쓰이지 않는 필드를 늘리지 않기 위해).
- 공용 네이티브 투영(`describeNativeWorkerEvent`)은 실제 경로인 `chat.ts`/`watch.ts`가 공유한다.
- 레거시 웹 UI를 네이티브 상태에 배선하는 것은 **별도 웹 기능**이며 여기서 하지 않았다.
  새 모니터링 사이트도 만들지 않았다.

## 웹 모니터링 실현 가능성 — 코드 기반 평가 (구현 아님)

사용자가 작업 중 물은 "웹에서 모니터링이 가능한가"에 대한 조사 결과만 기록한다.

**HQ가 이미 제공하는 것 (추가 백엔드 작업 거의 불필요)**

- `apps/gateway/src/managed-service.ts`가 v1 `/v1/progress` HTTP 표면을 서비스한다: 요청 제출,
  문맥 목록, NDJSON 이벤트 스트림.
- `apps/gateway/src/progress-store.ts`는 append-only 이벤트 로그(SQLite)다. 각 이벤트가
  `seq`/`eventKey`/`occurredAt`/`source`/`kind`/`payload`를 갖고, 문맥 스냅샷(`title`/`state`/
  `summary`/`projectIds`/`updatedAt`)이 따로 있다. `seq` 기반 재개와 compaction 스킵도 이미 있다.
- 네이티브 실행 상태는 이 로그에 그대로 들어 있다: `worker.launching|ready|retained|
  recovery_required` + `attemptId`/`worktreeId`/`requested`/`runId`/`taskId`/`dispatchId`/
  `terminalHandle`/`effective`.

즉 **단일 관찰자(뷰어 리스를 하나만 쓰는) 읽기 전용 웹 모니터**라면 기존 v1 API 위에 프런트엔드만
얹어도 동작은 한다. 다만 이는 `hq watch`/진행 창과 리스를 다투는 구성이며, 실서비스에서 기대할
다중 관찰자(웹 + 기존 watch를 동시에) 지원은 아래 제약 1번대로 **별도 백엔드 작업**이 필요하다 —
"프런트엔드만으로 충분하다"고 일반화할 수 없다.

**실제 제약 3가지 (설계 시 반드시 고려)**

1. **뷰어 리스가 문맥당 1개다.** `progress-store.ts`의 `acquireViewerLease`/`heartbeatViewerLease`는
   TTL 기반 단일 뷰어 모델이라, 웹 뷰어를 그대로 붙이면 `hq watch`/진행 창과 리스를 놓고
   경합한다. 다중 관찰자를 원하면 리스 없는 read-only 구독 경로를 **gateway에 새로 설계·구현**해야
   한다 — 이는 프런트엔드 작업이 아니라 백엔드(`progress-store.ts`/`managed-service.ts`) 변경이다.
2. **sanitization이 클라이언트 쪽에 산다.** `sanitizeDisplayText`/`sanitizeResultText`와
   `describeNativeWorkerEvent`는 `packages/installer/src/progress-client.ts`에 있다. 웹에서는
   같은 보호를 다시 구현하거나 공용 패키지로 올려야 한다(위 결함 3이 보여주듯 이건 실제 위험이다).
   이 역시 프런트엔드 단독 작업이 아니라 공유 가능한 패키지 경계를 새로 정하는 설계·구현 작업이다.
3. **`apps/web`은 지금 이 API를 읽지 않는다.** 현재 `apps/web`은 레거시 ControlStore/
   `dashboard.ts` 모델을 본다. 따라서 모니터링 화면은 기존 `apps/web` 데이터 경로의 확장이
   아니라 v1 위의 **새 표면**이 된다.

**HQ progress API vs 바깥 개발자 Orca Run의 차이 (중요)**

HQ는 Orca Run의 내부 타임라인을 읽지 않는다. HQ가 가진 것은 relay가 **영수증으로 돌려준
핸들**(`runId`/`taskId`/`dispatchId`/`terminalHandle`)과, `checkDelivery`/`processDelivery`로
받은 worker 메시지뿐이다(`apps/gateway/src/native-coordinator.ts`). 따라서 v1 위에 만든 웹
모니터가 보여줄 수 있는 것은 **"HQ가 본 네이티브 실행"**(어떤 워커가 어느 터미널/worktree에서
어떤 profile로 준비됐고, 무엇을 보고했는가)이지, Orca Run 안의 전체 대화·도구 호출 기록이
아니다. 후자를 웹에서 보려면 Orca 쪽에 별도의 Run 조회 브리지(HQ가 아닌 바깥 개발자 Orca Run
쪽 API)가 새로 필요하며, 이 저장소에는 없다.

**결론:** HQ가 이미 노출한 v1 progress API와 이벤트 로그는 **읽기 전용·단일 관찰자** 웹 모니터의
기반은 된다. 그러나 "프런트엔드 작업만으로 가능하다"는 결론은 과장이다: 다중 관찰자 지원(제약
1)과 sanitization 공유(제약 2)는 실제 백엔드/공유 패키지 설계·구현이 필요하며, 아직 아무것도
만들어지지 않았다. Orca Run 전체(외부 대화·도구 호출)를 웹에서 재현하려면 HQ progress API와는
별개로 Orca 쪽 Run 조회 브리지가 필요하고, 이는 이 저장소 범위 밖이다.

## 실행한 검증

- `npx vitest run packages/core/test/pilot-config.test.ts` → 7 passed
- `npx vitest run apps/gateway/test/managed-runtime.test.ts` → 10 passed, **unhandled error 0**
- `npx vitest run packages/installer/test/progress-client.test.ts` → 33 passed
- `npx vitest run packages/installer/test/setup.test.ts` → 5 passed
- `npm run typecheck` (루트 + tests + 워크스페이스 typecheck:test) → 통과
- `npx vitest run` (전체) → **92 files / 1222 tests passed, typecheck 통과, unhandled error 0**
  (coordinator가 review worker transcript의 최종 실행 — 2026-09-15 11:33:14 KST — 을 대조 확인한
  수치. 같은 세션 내 이전 실행에서 로그된 1221은 그 최종 실행 이전의 중간 카운트이며, Task 4의
  91 files / 1191 tests와 마찬가지로 과거 참고치로만 남긴다.)
- 전역 부작용이 있는 `build`/`prepare`(global install) 스크립트는 실행하지 않았다.

## 남은 범위 (Task 5 밖)

- 레거시 웹 UI(`apps/web` + `dashboard.ts`)를 네이티브 상태에 배선하는 별도 웹 기능.
- 위 실현 가능성 평가에 적은 두 선행 설계 결정(다중 뷰어 리스 모델, sanitization 공용화).
- 계획서 Task 6 이후(마이그레이션/복구, 네이티브 수용 검사)는 착수하지 않았다.
