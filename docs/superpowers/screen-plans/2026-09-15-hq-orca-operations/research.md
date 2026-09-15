# HQ + Orca 운영 화면 리서치

- 기준일: 2026-09-15 KST
- 대상: 단일 운영자용 한국어 데스크톱 HTML 시안. 모든 화면/수치는 **시뮬레이션**으로 표시한다.
- 상태 범주: **구현 백엔드**, **CLI 제공·브리지 필요**, **제안·미지원**을 섞지 않는다.

## 결론

1. HQ에는 요청/문맥/상태/이벤트 API가 있지만 문맥당 viewer lease가 하나다.
2. HQ context/event와 외부 Orca Run/Task/Dispatch는 다른 모델이다. 화면에서도 분리해야 한다.
3. 공개 Orca CLI 1.4.203은 운영에 필요한 read/control 명령을 제공하지만 브라우저용 API는 아니다.
4. 웹 제어에는 공개 CLI만 strict allowlist로 호출하는 local trusted bridge가 새로 필요하다.
5. 비용·토큰은 HQ와 확인한 Orca CLI 필드에 없다. 값/추정치를 만들지 말고 “수집되지 않음”으로 둔다.

## A. HQ 사실

### 설치·검증 상태

- installation result 기준 production HQ는 설치·정상 상태이며 `/health`, `hq status`, `hq jobs list`가 확인됐다.
- Task 5/6와 nullable terminal title 호환 수정은 커밋 `a98e43f` 기준 산출물로 설치됐다.
- Orca 1.4.201의 `title:null`을 nullable-as-missing으로 처리한 실제 호환 수정이다.
- Task 6 source-level migration/recovery acceptance는 완료됐다.
- 실제 native launch/result, GUI/terminal 가시성, live 혼합 채널 10+1, unlimited, terminal reuse 관찰은 아직 남았다.

### 정확한 progress API

HQ client는 local control Unix socket을 쓴다.

| 목적 | method/path | 입력·출력 핵심 |
|---|---|---|
| 제출 | `POST /v1/progress/requests` | in `{requestId,sessionId,text,contextHint?}`; 202 `{requestId,state:"queued"}` |
| 요청 | `GET /v1/progress/requests/:id` | `requestId,sessionId,state,contextIds,result?` |
| 문맥 목록 | `GET /v1/progress/contexts?sessionId=` | `{contexts}`; session 생략 가능 |
| 문맥 상세 | `GET /v1/progress/contexts/:id` | snapshot |
| 이벤트 | `GET /v1/progress/events?...&after=N&follow=1` | contextId/sessionId 중 하나, NDJSON |
| lease | `POST .../:id/viewer-lease` | `{viewerInstanceId}` → acquired/token/expiresAt |
| heartbeat | `POST .../:id/viewer-heartbeat` | `{viewerInstanceId,leaseToken}` |
| lease 해제 | `DELETE .../:id/viewer-lease` | 같은 holder body |

- `contextHint`: `{mode:"new"}` 또는 `{mode:"continue",contextId}`.
- route 기준 text 최대 8,000자, identifier `[A-Za-z0-9_-]{1,100}`.
- 같은 requestId+body는 idempotent다. retry용 새 ID를 만들면 중복 의미가 달라진다.
- request state: `queued|classifying|awaiting_input|executing|completed|failed|recovery_required`.
- context: `contextId,title,state,summary,projectIds,jobIds,createdAt,updatedAt,lastSeq`.
- event: `seq,eventKey,requestId,contextId,kind,source,occurredAt,payload,agentId?,generation?`.
- source: `hq|tool|orca|system`.
- native kind: `worker.launching|ready|retained|recovery_required`.
- launch payload: `attemptId,worktreeId,requested{agent,model,effort?,reason}`.
- ready/retained에는 `runId,taskId,dispatchId,terminalHandle,effective{agent,model?,effort?}`가 추가된다.
- 값이 optional이면 “기본값”으로 채우지 않고 “미확인”으로 둔다.
- compaction frame은 seq 없이 `oldestSeq,latestSeq,snapshots`; snapshot 적용 후 latestSeq부터 재개한다.
- stream heartbeat는 연결 생존 신호이지 worker 진행 증거가 아니다.

### 제약

- 문맥당 활성 viewer lease는 하나라 웹이 `hq watch`/진행 창과 경합한다.
- lease close는 구독권만 끝내며 worker stop이 아니다.
- 동시 viewer에는 lease-free read fan-out 또는 다중 subscriber backend가 필요하다.
- sanitization은 installer client에 있어 공용 패키지화/동일 계약 재사용이 필요하다.
- `apps/web`/`dashboard.ts`는 legacy ControlStore 모델이며 native progress UI가 아니다.
- maxActiveWorkers 기본 10; positive safe integer 또는 `"unlimited"` 설정 가능.
- config file 값 우선, 비어 있을 때만 `HQ_MAX_ACTIVE_WORKERS` 사용.
- `unknown|release_pending|release_unknown|transferred`도 점유다. unknown 자동 재시작/빈 슬롯 처리는 금지한다.
- HQ에는 usage/cost/token/currency 필드가 없다. 보안 token을 사용량으로 오해하지 않는다.

### HQ와 Orca 경계

```text
HQ request → HQ context → HQ progress event → receipt의 Orca ID
외부 Orca Run → Task → Dispatch → worker terminal/resource/message
```

- HQ는 receipt/message로 받은 Orca ID만 안다. 전체 Orca 대화·tool call·transcript는 없다.
- 상세에 `HQ 작업`/`Orca Run` source badge를 고정하고 ID가 있을 때만 상호 탐색한다.
- 연결 ID 부재는 “아직 없음”이지 실패/legacy로 추정할 근거가 아니다.

## B. 공개 Orca CLI

### 확인 환경

- `orca --version`과 `status --json`: 1.4.203, app running, runtime ready/reachable/connected.
- version-matched `orca skills get orca-cli`, `orca skills get orchestration`, 각 command help를 확인했다.
- 공개 CLI만 사용한다. private DB/RPC API는 계획에 포함하지 않는다.

### read surface와 필드

| 데이터 | 정확한 command | 핵심 필드 |
|---|---|---|
| runtime | `orca status --json` | running/pid, state/reachable/connectionState/runtimeId/appVersion/capabilities |
| Run | `orchestration run-list --limit N --json`, `run-show --id` | id/objective/coordinator/generation/legacy/timestamps/cursor |
| Task | `orchestration task-list --run R --brief --json` | id/parent/title/spec/status/deps/result/assignee/dispatch/timestamps |
| worker | `orchestration worker-list --run R --include-remote --limit N --json` | projection/resource/count/page/scope |
| 상세 | `orchestration worker-show --dispatch D --json` | dispatch/observation/projection |
| 출력 | `orchestration worker-read --dispatch D --source auto --limit N --json` | exact transcript 우선, 아니면 labeled terminal, cursor |
| 메시지 | `orchestration check ...`, `inbox --terminal H --limit N --json` | FIFO delivery/messages |
| project | `project list --json`, `project setups --project P --json` | id/kind/displayName/repoIds, host/path availability |
| worktree | `worktree list/show/current --json` | full `<repoId>::<path>`, host/git/lineage/linked item/status |
| terminal | `terminal list/show/read --json` | handle/title/connected/writable/orphaned/incarnation/worktree/lastOutput/preview/cursors |

- worker identity: `dispatchId,taskId,runId,role,parent,provider,host,workspace`.
- stage(`worker,dispatch,detail,activity`), outcome, liveness, evidence, resource, attention, nextAction은 별도다.
- list `projection.liveness`는 agent fleet verdict, show `observation.status`는 PTY liveness다.
- live terminal이 healthy agent를 보장하지 않는다.
- `agentWait:null`은 검사 결과 없음; 필드 부재는 미검사/구버전/판독 불가다.
- `unverifiable`/absence/connection loss는 종료가 아니며 stop/retry/release 근거가 아니다.
- `nextAction.kind:none`이면 실행 argv가 없다. UI가 임의 복구 버튼을 만들지 않는다.
- remote scope의 not-covered host에서 빈 목록은 “작업 없음” 증거가 아니다.

### 질문·follow-up·lifecycle

- `question-list/show`는 없다. 질문은 check/inbox의 `type:"question"` 메시지다.
- 답변: `orchestration reply --id M --body TEXT --json`.
- 지시: `orchestration send --to dispatch:D --subject ... --body ... --type status --json`.
- terminal 직접 입력이 꼭 필요할 때만 `terminal send`; 구조화 follow-up은 dispatch message를 우선한다.
- lifecycle은 help만 확인: `worker-stop --dispatch D`, `worker-retain --dispatch D`, `worker-release --dispatch D`.
- stop은 exact supervised agent terminal만 fence/stop하며 worktree/다른 tab은 삭제하지 않는다.
- retain은 durable exception만 기록하고 process/filesystem 동작이 없다.
- release는 accepted settlement 후 exact owned terminal을 archive하고 닫는 cleanup이지 취소가 아니다.
- `terminal close`, Orca worker stop, HQ viewer close를 서로 대체하지 않는다.

### 필요한 web bridge

- browser → loopback trusted bridge → allowlisted public Orca CLI → JSON projection.
- browser가 executable/path/raw argv/shell string을 보내게 하지 않는다.
- read allowlist: status, run/task/worker/inbox/project/worktree/terminal의 list/show/read/peek.
- control allowlist: reply/send/worker-stop/retain/release를 별도 typed endpoint로 둔다.
- server가 조회한 opaque ID만 받고 principal/local user/Run/Dispatch/worktree/host scope를 교차 검증한다.
- CSRF, origin allowlist, OS user 또는 짧은 session capability; remote는 opt-in TLS+host allowlist+재인증.
- control: 확인 화면 → 최신 상태 재조회 → exact ID 검증 → 실행 → receipt 저장.
- audit는 command family/opaque target/outcome/requestId/time만; body/transcript/secret은 기본 redaction.
- token/secret/password/authorization/cookie/private key/URL credential은 server-side 제거한다.
- timeout/connectionLost/source_changed/release_unknown을 성공으로 정규화하지 않는다.
- capability/version mismatch는 disable+이유 표시; private API fallback은 금지한다.

## C. 외부 공식 자료

모두 2026-09-15 live HTTP 확인. 날짜 미표시를 추정하지 않았다.

1. OpenAI [Codex cloud](https://learn.chatgpt.com/docs/cloud), 200, 날짜 표시 없음: isolated parallel tasks, background logs, summary/diff, follow-up, PR. OpenAI 소개 URL은 403이라 이 공식 Learn 문서로 대체.
2. Anthropic [Agent teams](https://code.claude.com/docs/en/agent-teams), 200, `dateModified=2026-09-10T18:38:54.691Z`: shared tasks/messages/panel/dependencies. Experimental/default-off, resume/coordination/shutdown 제한과 높은 token cost 명시.
3. GitHub [About agent management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management), 200, 날짜 표시 없음: centralized Agents, live logs, active sessions, steering, IDE/CLI handoff, review/automation.
4. Cursor [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints.md), 200, 날짜 표시 없음: public beta; durable agent와 per-prompt run, list/get/stream/cancel/usage/artifact/archive. 구 background URL은 cloud-agent로 redirect.
5. Linear [Agents Getting Started](https://linear.app/developers/agents), 200, 날짜 표시 없음: human assignee를 유지한 `delegate`, OAuth app actor/scopes/webhook; Developer Preview.
6. LangSmith [Observability concepts](https://docs.langchain.com/langsmith/observability-concepts), 200, `dateModified=2026-08-04T14:59:41.597Z`: run→trace→thread와 flat trajectory/messages를 목적별 분리.
7. Langfuse [Observability overview](https://langfuse.com/docs/observability/overview), 200, 날짜 값 표시 없음: nested observations, latency, usage/cost, score/dashboard/alert. 계측 제품 사례이지 HQ 구현 증거가 아니다.

### 근거 기반 UX 경향 5개

1. **목록→attention→증거**: GitHub 중앙 목록, Claude panel, Orca attention을 `운영 개요→관심함→상세`에 적용.
2. **work/execution 분리**: Cursor agent/run, Orca Task/Dispatch를 `작업 목록/실행 상세`로 분리.
3. **중간 개입**: OpenAI follow-up, GitHub steering, Claude message를 `질문함/후속 지시`에 적용.
4. **summary와 raw evidence 이중 뷰**: 첫 화면은 요약, 상세에서 timeline/log/diff로 drill-down.
5. **사람 소유권 유지**: Linear delegate/Orca coordinator authority를 destructive control 확인에 적용.

### 피할 패턴 2개

1. HQ context, Orca Run, terminal log를 한 “통합 타임라인”으로 합쳐 identity/관찰 수준을 지우기.
2. 실제 계측 없는 token/cost/진행률/ETA를 mock KPI로 채우기.

### 접근 3안과 추천

| 안 | 장점 | 위험 |
|---|---|---|
| A HQ-only viewer | 가장 빠름 | single lease 경합, Orca 전체 부재 |
| B 이중 원천 콘솔 | 요구 충족, 점진 구현 | bridge/auth/redaction와 multi-viewer 필요 |
| C 공통 trace 플랫폼 | 장기 분석/품질 운영 | 현재 미지원, 계측·저장·변환 범위 큼 |

**추천 B**: read-heavy 콘솔로 시작해 reply/follow-up부터 control을 연다. stop/release는 최신 상태 검증과 별도 확인 뒤 추가하고, C의 cost/trace는 실제 계측 계약 이후 확장한다.

## 화면 제안

1. **운영 개요**: HQ health, Orca runtime/version/connection, 마지막 수집 시각; HQ 작업/Orca Run 두 열; question/recovery/unknown/unverifiable/disconnect 관심함; HQ capacity. cost는 “수집되지 않음”.
2. **작업 지시/context follow-up**: session, text, new/continue, requestId, 8,000자 제한. accepted/queued를 완료로 보이지 않는다.
3. **작업 목록**: HQ snapshot tab과 Orca Run/Task/Dispatch tab; source/검증 수준 badge; attention filters.
4. **상세 timeline/log**: HQ seq/source/kind/compaction; Orca projection/observation/bounded worker-read; log 기본 접힘+redaction/source 표시.
5. **질문함**: HQ clarification과 Orca question을 source별 queue로 표시; exact messageId reply receipt, pending timeout/disconnect.
6. **projects/terminals**: project→host setup→worktree→terminal 계층. connected/writable/orphaned/incarnation 표시; viewer-close/terminal-close/worker-stop 분리.
7. **capacity/settings**: default10/configurable/unlimited, unknown 포함 occupancy, requested/effective. 설정 mutation은 1차 미지원/read-only.
8. **증거/implementation map**: 각 필드에 HQ API/Orca CLI/bridge/simulated provenance, route/command/receipt/error/redaction policy.

## 상태 UX

| 상태 | 표시와 동작 |
|---|---|
| collecting | skeleton, last cursor/time, cancel |
| connected | 중립 “연결됨”; 성공과 혼동 금지 |
| disconnected | 마지막 성공 시각, read retry; lifecycle 추정 금지 |
| error | code/source/영향 범위와 동일 read retry |
| unknown | “상태 확인 필요·용량 점유”; inspect만 |
| recovery_required | 원인/receipt/guide; 증거 후 복구 |
| question | attention 최상단; exact reply |
| unverifiable | “종료 증거 없음”; wait/inspect만 |
| stopped | positive receipt와 시각 |
| viewer closed | 구독 종료; worker 상태 불변 |

## capability matrix

| feature/data/action | HQ today | pure Orca CLI today | bridge/product work | UI consequence |
|---|---|---|---|---|
| health/runtime | `/health`, HQ status | `status --json` | read proxy | source별 상태 |
| submit/follow-up | POST new/continue | send/reply; worker-start는 별도 lifecycle | typed endpoints/identity map | accepted≠done |
| HQ list/timeline | context/request/NDJSON | 없음 | lease-free fan-out | HQ tab |
| Run/Task/worker | receipt ID만 | run/task/worker list/show | JSON projection | Orca tab |
| log | HQ events | worker/terminal read | paging/redaction | raw 기본 접힘 |
| question | clarification event | check/inbox/reply | attention+idempotency | source 구분 |
| project/worktree | IDs 일부 | project/worktree list/show | selector allowlist | hierarchy |
| terminal | receipt handle | list/show/read | read-first | close/stop 분리 |
| stop | native stop path | worker-stop | high-risk confirm | 최신 상태 검증 |
| viewer close | lease DELETE | 없음 | 기존 route | worker 불변 |
| retain/release | retention event 일부 | retain/release | settlement gate | cleanup 표시 |
| capacity | default10/unlimited, unknown 점유 | worker counts/resource | projection | 점유 분해 |
| remote | local managed | include-remote/scope | TLS/auth/host scope | not-covered 경고 |
| cost/tokens | **없음** | **확인되지 않음** | 새 계측 | 수집되지 않음 |
| multi-viewer | single lease | 해당 없음 | backend 필요 | 경합 경고 |
| settings/control | config 계약 | lifecycle command | 별도 제품 설계 | 1차 제한 |
| unified trace/eval | 미지원 | 미지원 | future observability | roadmap 후보 |

## 근거와 gap

- HQ: installation result, Task 5 review, Task 6 result, progress control/store/client/core schema, worker admission/managed runtime 관련 절.
- Orca: CLI 1.4.203 live status/help, version-matched orca-cli/orchestration guide, read-only JSON 관찰.
- gap: multi-viewer, shared sanitization, trusted bridge/auth/audit, HQ↔Orca join, live-native/GUI acceptance, cost/trace 계측, settings UX.
- 외부 자료는 UX 참고이며 HQ/Orca 구현 증거가 아니다.
