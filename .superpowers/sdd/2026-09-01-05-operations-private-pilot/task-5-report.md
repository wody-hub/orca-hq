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
