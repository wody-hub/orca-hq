# Plan 5 Task 5 구현 보고서

## 결과 요약

deterministic fake Slack·Telegram·agent와 sandbox Git 저장소를 기존 공개 경계에 연결한 private-pilot acceptance/chaos harness를 구현했다. 산출 보고서는 `evidenceMode: "deterministic_simulation"`, `pilotReady: false`를 고정하고, 12개 criterion을 각각 한 번씩 scripted scenario evidence에 매핑하며 모든 criterion에 `live_gate_required`를 남긴다.

이 결과는 실측 인증이 아니다. 실제 Slack·Telegram·Tailscale 로그인, 실제 Codex/Claude 계정, 실제 Orca worker, 실제 Mac 재부팅/launchd, 동료 clean-machine 설치를 실행하거나 증명하지 않았다.

## TDD RED → GREEN

| 단계 | 명령/대상 | 관찰 결과 |
|---|---|---|
| RED 1 | `pnpm build && pnpm test tests/e2e tests/chaos` | 3개 파일 7개 테스트가 `runPilotAcceptance is not a function`으로 실패했다. 누락된 harness 공개 계약 때문에 실패함을 확인했다. |
| GREEN 1 | deterministic fakes, public-boundary harness 구현 후 focused 실행 | 3개 파일 7개 테스트가 통과했다. |
| RED 2 | runner CLI 계약 테스트 | `scripts/run-pilot-acceptance.mjs` 부재로 1개 테스트가 `MODULE_NOT_FOUND` 실패했다. |
| GREEN 2 | bounded output, 양의 정수 runs, fixed redacted error, gate 구현 | runner 계약을 포함한 e2e 테스트가 통과했다. |
| RED 3 | 양 채널의 변경/만료 승인 거절과 retry exhaustion 기대값 추가 | 2개 테스트가 누락 evidence로 실패했다. |
| GREEN 3 | Slack·Tailscale 각각 exact/changed/expired 검증과 제3 launch 차단 구현 | 보강 대상 2개 파일 7개 테스트가 통과했다. |
| 회귀 진단 | 전체 `pnpm test` | runner 테스트의 매번 dependency build가 병렬 CPU를 점유해 기존 installer process 테스트 1개가 timeout 됐다. simulation 자체 0.31초, 불필요한 build 포함 runner 5.42초/CPU 20.66초를 확인했다. |
| 회귀 GREEN | fresh/stale dist에서만 dependency build, 최신 dist 재사용 | 전체 45개 파일 655개 테스트가 통과했다. |

## Scenario와 criterion 매핑

| Scenario ID | 검증한 scripted counterpart | 매핑 criterion |
|---|---|---|
| `documented_install_live_gate_marker` | harness 경계와 clean-machine 미실행 표식 | `coworker_documented_install` |
| `scripted_channel_authentication_boundaries` | fake Slack·Telegram 연결과 deterministic local Tailscale session | `channels_authenticate` |
| `korean_voice_verified_l1` | 한국어 synthetic voice, transcript 승인, route/plan, isolated worktree, Codex→Claude 검증, 전체 audit linkage | `korean_telegram_voice_to_codex_hq`, `route_evidence_and_plan_preview`, `l1_isolated_worktree`, `both_model_families_implement`, `cross_model_verification`, `complete_user_visible_audit_trail` |
| `reverse_model_verification` | Claude 구현→Codex 검증 | `both_model_families_implement`, `cross_model_verification` |
| `duplicate_provider_delivery` | Slack·Telegram duplicate가 command/DAG/execution 한 개로 귀결 | 관련 중복 방지 scenario evidence |
| `digest_bound_approvals` | Slack·Tailscale 각각 exact digest 승인, changed/expired 거절 | `slack_tailscale_digest_bound_expiring_approval` |
| `telegram_privileged_denials` | L2/L3 callback과 commit/push/PR/merge/deploy/database/deletion/secret operation 거절 | `telegram_privileged_approval_denied` |
| `restart_reconciliation` | simulated gateway/Orca/Mac 및 fake 채널 reconnect의 resumable 또는 `review_required` 분류 | `restart_reconciliation` |
| `agent_failure_safety` | Codex auth loss queue/review, Claude HQ takeover 0, 안전 retry 1회, 검증 2-cycle 실패 후 intervention | `failed_verification_never_succeeds` |
| `pre_dispatch_safety` | wrong-project ambiguity와 dirty checkout 차단 | `l1_isolated_worktree` |
| `outbox_recovery_exactly_once` | provider 실패, stale claim 복구, 정확히 1회 전달 | delivery/restart scripted evidence |

12개 criterion ID는 다음 순서로 정확히 한 번씩 report에 존재한다.

1. `coworker_documented_install`
2. `channels_authenticate`
3. `korean_telegram_voice_to_codex_hq`
4. `route_evidence_and_plan_preview`
5. `l1_isolated_worktree`
6. `both_model_families_implement`
7. `cross_model_verification`
8. `failed_verification_never_succeeds`
9. `telegram_privileged_approval_denied`
10. `slack_tailscale_digest_bound_expiring_approval`
11. `restart_reconciliation`
12. `complete_user_visible_audit_trail`

## Metrics 근거

수치는 상수로 report에 넣지 않고 scenario event를 집계한다.

| Metric | 20회 결과 | 산출 근거 |
|---|---:|---|
| `restartRecoveryRate` | `1` | 6 restart/reconnect case × 20 run = 120 attempt, 120 recovered/review-required 안전 분류 |
| `duplicateExecutions` | `0` | duplicate provider command 수 증가분이 1을 넘을 때만 생성되는 `duplicate_execution` event 개수 |
| `approvalBypasses` | `0` | Telegram privileged policy 결과가 channel rejection이 아닐 때만 생성되는 `approval_bypass` event 개수 |
| `verifiedSuccessCoverage` | `1` | 2 verified-success direction × 20 run = 40 success, 40 verifier-evidence event |

`node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/pilot-report.json`은 exit 0이었다. 생성 JSON은 12개 criterion/12개 unique criterion, 11개 scenario, 모든 status pass, 위 네 metric을 만족했다.

## 사용한 기존 공개 경계

- Slack `toCommandEnvelope`, Telegram `createTelegramAdapter`/`toTelegramVoiceCommand`
- `ControlStore`, `ApprovalService`, `authorizeProposal`
- `routeProject`, `decideRankedRoute`, `GitWorktreePlacementService`, sandbox Git
- `VerificationService`와 교차 model verifier 선택/완료 gate
- gateway `reconcileStartup`
- `OutboxDispatcher`, Tailscale local session service

fake의 clock, run/command ID, transcript, agent receipt, provider response, restart inspection은 고정 또는 주입 가능하다. 실제 network와 credential/config 저장소는 사용하지 않았다.

## 변경 파일

- `tests/e2e/private-pilot.spec.ts`
- `tests/chaos/restart.spec.ts`
- `tests/chaos/provider-failures.spec.ts`
- `tests/tsconfig.json`
- `packages/test-support/src/fake-slack.ts`
- `packages/test-support/src/fake-telegram.ts`
- `packages/test-support/src/fake-agents.ts`
- `packages/test-support/src/pilot-harness.ts`
- `packages/test-support/src/index.ts`
- `packages/test-support/package.json`
- `scripts/run-pilot-acceptance.mjs`
- `apps/gateway/package.json` (기존 lifecycle/reconcile의 test-support용 public subpath export만 추가)
- `vitest.config.ts`
- `package.json`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-09-01-05-operations-private-pilot/task-5-report.md`

## 최종 검증

- focused build/e2e/chaos: 3개 파일 8개 테스트 통과
- test-support typecheck/build: 통과
- tests 전용 typecheck: 통과
- 전체 테스트: 45개 파일, 655개 테스트 통과
- 전체 typecheck: 통과
- 전체 build: 통과
- 20회 acceptance gate: 통과
- JSON schema/criterion/metric 확인: 통과
- `git diff --check`: 허용 파일 범위와 staged diff 모두 통과

## 자체 리뷰 및 안전 경계

- production 동작은 변경하지 않았고 gateway의 이미 존재하는 public lifecycle/reconcile 모듈을 package subpath로 노출하는 wiring만 추가했다.
- 보고서의 모든 criterion evidence에 `live_gate_required:clean_pilot_mac`를 둬 scripted pass를 실제 pilot pass로 오인하지 않게 했다.
- runner output은 workspace의 직접 `.artifacts/*.json` 파일로 제한하고 symlink/non-file을 거절한다. 실패 메시지는 고정 문자열이며 provider/credential payload를 출력하지 않는다.
- `.artifacts/**`는 커밋하지 않는다.
- 보호 경로와 실제 Slack·Telegram·Tailscale·Keychain·launchd·Orca credential/config는 수정하지 않았다.
- Task 6 이후 실제 clean pilot Mac에서 동료 설치, 채널 로그인, 실제 agent 실행, 실제 재부팅과 launchd recovery를 별도 검증해야 한다.

---

## 수정 라운드 1 — C1~C3 / I1~I3

### RED → GREEN 증거

| 단계 | 명령/대상 | 관찰 결과 |
|---|---|---|
| RED | C3 durable cursor 테스트 | `firstStore.saveChannelCursor is not a function`으로 실패해 실제 cursor 저장 경계 부재를 확인했다. |
| RED | C2 delivery audit 테스트 | `outbox.delivered` 기대에 실제 audit `[]`가 반환됐다. |
| RED | I1 gate 및 C3 restart seam 테스트 | 기대한 공개 함수가 없어 `expected "function", received "undefined"`로 실패했다. |
| RED | I3 양 방향 verifier evidence 손실 테스트 | 기대 coverage `0.5`에 실제 `1`이 반환돼 성공과 evidence가 결합돼 있음을 확인했다. |
| RED | C1 인증 손실/launch retry 테스트 | 실제 결과 속성을 요구하자 기존 리터럴에는 값이 없어 `received undefined`로 실패했다. |
| RED | C2 production audit 테스트 | `command.route_selected`, `command.policy_authorized`, `command.policy_approval_required`, `outbox.delivered`가 누락됐다. |
| RED | I2 duplicate evidence 테스트 | 실제 계측은 command뿐인데 기존 evidence가 `commands=1:dags=1:executions=1`을 주장해 실패했다. |
| GREEN | `pnpm test packages/persistence/test/store.test.ts packages/persistence/test/outbox-dispatcher.test.ts apps/gateway/test/end-to-end.test.ts tests/e2e/private-pilot.spec.ts tests/chaos/restart.spec.ts tests/chaos/provider-failures.spec.ts` | 6개 파일, 62개 테스트가 통과했다. |
| 통합 진단/수정 | Korean production flow 단독 테스트 | 첫 통합 실행은 `provider_environment_isolation_unavailable`로 실패했다. helper가 production `ExecutionService`에 test provider capability를 전달하지 않은 것이 원인이었고, 기존 production host와 같은 검증된 allowlist/same-host capability를 주입한 뒤 해당 테스트와 private-pilot 8개 테스트가 통과했다. |

### Finding별 변경

- **C1**: `FakeAgents`는 이제 실제 `CodexHqSession`에 `CodexPortError("authentication_required")`만 주입하고 queue defer 및 authority-model 호출 기록에서 인증 손실 결과를 산출한다. launch failure는 실제 `ExecutionService.start`/`recordLaunchFailure`, SQLite `ControlStore`, Orca provider 호출 기록을 통과해 retry 1회와 attempt-two intervention을 계산한다.
- **C2**: harness의 직접 `appendAudit` 자기삽입을 제거했다. production gateway가 command 기준 route/policy audit을, `OutboxDispatcher`가 redacted delivery audit을 생성하고, 실제 lifecycle/worker/verifier audit과 관계를 따라 7개 linkage를 검증한다.
- **C3**: Slack/Telegram cursor를 `ControlStore`에 타입별로 저장·복원하는 public seam을 추가했다. file-backed SQLite를 닫고 다시 연 뒤 command/approval/lock/outbox/cursor snapshot을 비교하며, 실제 `reconcileStartup` 결과와 provider launch 호출 수에서 resumable, `review_required`, uncertain worker release 0, duplicate dispatch 0을 산출한다.
- **I1**: `pilotAcceptancePassesGate`가 모든 criterion뿐 아니라 모든 필수 scenario의 pass를 요구한다. `outbox_recovery_exactly_once`를 restart criterion에 연결했고 duplicate/outbox scenario를 강제로 fail시킨 gate 테스트를 추가했다.
- **I2**: duplicate evidence를 실제로 센 `commands=1`로 축소하고 Slack/Telegram command 개수를 numeric measurement로 노출·검증한다.
- **I3**: 각 방향의 `verified_success`와 `verified_success_evidence`를 독립 event로 방출한다. Codex→Claude 또는 Claude→Codex 중 한쪽 evidence를 제거하면 분모 2가 유지되고 coverage가 정확히 `0.5`가 되며 scenario/gate가 실패한다.

### 수정 라운드 1 최종 검증

- `pnpm --filter @orca-hq/test-support typecheck`: 통과
- `pnpm test`: 45개 파일, 665개 테스트 통과
- `pnpm typecheck`: 통과 (`tests/tsconfig.json` 포함)
- `pnpm build`: 15개 workspace project 범위 통과
- `node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/pilot-report.json`: exit 0
- 생성 JSON 기계 검증: schema true, criterion 12개/unique, scenario 11개 전부 pass, `restartRecoveryRate=1`, `duplicateExecutions=0`, `approvalBypasses=0`, `verifiedSuccessCoverage=1`
- `git diff --check`: 통과

### 수정 라운드 1 변경 파일

- `apps/gateway/package.json`
- `apps/gateway/src/production.ts`
- `apps/gateway/test/end-to-end.test.ts`
- `packages/persistence/src/index.ts`
- `packages/persistence/src/outbox-dispatcher.ts`
- `packages/persistence/src/store.ts`
- `packages/persistence/test/outbox-dispatcher.test.ts`
- `packages/persistence/test/store.test.ts`
- `packages/test-support/package.json`
- `packages/test-support/src/fake-agents.ts`
- `packages/test-support/src/fake-slack.ts`
- `packages/test-support/src/fake-telegram.ts`
- `packages/test-support/src/index.ts`
- `packages/test-support/src/pilot-harness.ts`
- `packages/test-support/src/production-pilot.ts`
- `scripts/run-pilot-acceptance.mjs`
- `tests/chaos/provider-failures.spec.ts`
- `tests/chaos/restart.spec.ts`
- `tests/e2e/private-pilot.spec.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-09-01-05-operations-private-pilot/task-5-report.md`

### 자체 리뷰 및 안전 경계

- 새 테스트는 각 finding이 잡는 production mutation을 이름/주석으로 명시하고, 실제 service/store/provider observable을 검증한다. 정답 리터럴 되읽기, setup/expectation mirror, mock 자체 assertion, evidence 문자열만으로 duplicate/restart를 주장하는 경로를 제거했다.
- production 변경은 승인된 최소 audit producer와 cursor persistence seam, gateway `./production` export에 한정했다. 외부 network/credential/config를 읽거나 변경하지 않았고 모든 provider 동작은 deterministic fake와 sandbox Git에서 수행했다.
- 기존 dirty 보호 경로는 stage·restore·삭제하지 않는다. 요구된 acceptance runner의 `.artifacts/pilot-report.json`만 생성 검증했으며 `.artifacts/**`, `apps/web/test-results/**`, roadmap 보호 파일은 커밋 대상에서 제외한다.
- 남은 범위는 실제 clean pilot Mac에서의 실채널·실계정·실재부팅 검증이며 이 deterministic 수정 라운드의 완료 조건에는 포함되지 않는다.

---

## 수정 라운드 2 — N1

### 원인과 변경 이유

`packages/test-support/src/production-pilot.ts`가 하나의 `command.policy_authorized` audit을 보고 `policy`와 `approval` 두 축을 모두 추가해, L1에서 실제 승인 관측이 없어도 전체 linkage가 통과했다. L1은 승인이 필요하지 않다는 실제 production 정책 결정을 안전하게 관측할 수 있도록 승인받은 최소 production seam `command.policy_approval_not_required`를 추가하고, `policy_authorized`는 `policy`만, 새 approval-specific event는 `approval`만 충족하도록 분리했다. event subject는 동일 command ID이고 data는 `proposalId`와 `riskLevel`만 포함하므로 prompt, transcript, credential, provider payload, 회사 경로를 기록하지 않으며 실행·승인·전달 제어 흐름은 바꾸지 않는다.

### TDD RED 원문

`pnpm test tests/e2e/private-pilot.spec.ts`의 기존 코드 실행은 9개 중 2개가 다음과 같이 실패했다.

```text
FAIL ... drives Korean Telegram voice through the public boundaries to verified L1 evidence
-   "approval_evidence:command.policy_approval_not_required",

FAIL ... does not derive approval linkage from policy authorization alone
-   "status": "fail",
+   "status": "pass",
Test Files  1 failed (1)
Tests  2 failed | 7 passed (9)
```

가장 가까운 production gateway test에도 같은 producer 계약을 먼저 추가했다. `pnpm test apps/gateway/test/end-to-end.test.ts`는 다음처럼 실제 audit 부재로 실패했다.

```text
FAIL ... moves Telegram message 501 through worker, verifier and a delivered verified-success Outbox
-     "eventType": "command.policy_approval_not_required",
Test Files  1 failed (1)
Tests  1 failed | 9 passed (10)
```

production 변경 전 Orca `ask`로 `apps/gateway/src/production.ts`의 정확한 seam, 대안, data 경계, 동작 영향 없음을 보고했고 승인을 받은 뒤 구현했다.

### GREEN 및 회귀 검증

- `pnpm --filter @orca-hq/gateway build && pnpm test tests/e2e/private-pilot.spec.ts`: 새 fault-injection이 의도대로 시나리오를 fail로 전환했고, failure evidence의 기존 prefix를 반영한 뒤 통과했다.
- `pnpm test tests/e2e/private-pilot.spec.ts apps/gateway/test/end-to-end.test.ts`: 2개 파일, 19개 테스트 통과.
- `pnpm test packages/persistence/test/store.test.ts packages/persistence/test/outbox-dispatcher.test.ts apps/gateway/test/end-to-end.test.ts tests/e2e/private-pilot.spec.ts tests/chaos/restart.spec.ts tests/chaos/provider-failures.spec.ts`: 6개 파일, 63개 테스트 통과.
- `pnpm --filter @orca-hq/test-support typecheck`: 통과.
- 최초 두 번의 `pnpm test`: 각각 installer process test 한 건이 병렬 부하에서 2초 timeout으로 실패하고 나머지 665개는 통과했다. 변경 범위 밖 동일 파일을 단독 실행한 `pnpm test packages/installer/test/cli-process.test.ts`는 5개 모두 통과했고, stale test-support 산출물이 runner 내부 build를 유발하는 기존 경합 조건을 제거하도록 전체 build 후 재실행했다.
- `pnpm typecheck`: root 및 `tests/tsconfig.json` 통과.
- `pnpm build`: 15개 workspace project 통과.
- 산출물 최신화 후 새 `pnpm test`: 45개 파일, 666개 테스트 통과.
- `node scripts/run-pilot-acceptance.mjs --runs 20 --output .artifacts/pilot-report.json`: exit 0.
- 생성 JSON 검증: schema true, criterion 12개/unique 12, scenario 11개 전부 pass, `approval_evidence:command.policy_approval_not_required` 존재, `restartRecoveryRate=1`, `duplicateExecutions=0`, `approvalBypasses=0`, `verifiedSuccessCoverage=1`.
- `git diff --check` (허용 파일 범위): 통과.

### 실제 audit 근거와 자체 리뷰

- 정상 L1 production flow는 동일 command subject로 `command.policy_approval_not_required`와 `command.policy_authorized`를 각각 생성한다. gateway E2E가 새 event의 data를 `{ proposalId, riskLevel }` 정확값으로 검증한다.
- test-support는 `command.policy_authorized`에서 `policy`만 수집하고, 동일 command의 `command.policy_approval_not_required`를 실제로 찾았을 때만 `approval`과 `approval_evidence:command.policy_approval_not_required`를 추가한다.
- `missing_approval_specific_event` fault-injection은 approval-specific 관측만 제거한다. 이때 `policy_authorized`가 남아 있어도 `korean_voice_verified_l1`이 `audit_linkage_incomplete`로 fail하므로 기존 N1 mutation을 잡는다.
- C1~C3/I1~I3 회귀 묶음은 모두 통과했고 N2~N4 및 M1~M7은 변경하지 않았다. `.artifacts/**`는 stage하지 않으며 보호 경로와 실제 Slack·Telegram·Tailscale·Keychain·launchd·Orca credential/config를 읽거나 변경하지 않았다.
