# clean verifier lifecycle 최종 하드닝 보고서

## 결과

`scripts/verify-clean-workspace.mjs`에 repository-local 원자 잠금, stale-run fail-closed, SIGINT/SIGTERM의 child 종료 후 복원, 부분 복원 실패 시 백업 보존과 나머지 원본 복원 지속을 구현했다. 정상 종료와 처리 가능한 신호 종료는 자신이 만든 `run-*`과 `active.lock`만 제거하며, 기존 sibling 경로는 유지한다.

## 원인과 수정

- 기존 검증 명령은 `spawnSync`로 실행되어 verifier가 신호를 받은 뒤 JavaScript `finally` 복원 경로로 돌아올 수 없었다. 비동기 `spawn`으로 전환하고 SIGINT/SIGTERM 수신 시 현재 child에 같은 신호를 전달한 뒤 `close`를 기다리도록 수정했다. 복원이 끝난 후 SIGINT는 130, SIGTERM은 143으로 종료한다.
- 기존 staging에는 실행 간 소유권 경계가 없었다. 어떤 `dist/`도 이동하기 전에 `.clean-workspace-staging/active.lock` 디렉터리를 원자적으로 생성하고, 획득 실패 시 정확한 경로와 수동 확인 필요성을 출력하며 중단한다.
- 잠금 획득 후 기존 `run-*`을 발견하면 원본/생성물을 추측하지 않고 정확한 stale 경로를 알린 뒤 중단한다. 이 경로에서는 자신이 획득한 lock만 해제한다.
- generated sweep와 개별 원본 restore는 항목별 오류를 수집하면서 계속 진행한다. 하나라도 실패하면 해당 run을 삭제하지 않고, `AggregateError`가 보존된 backup 위치를 안내한다.

## 실제 subprocess RED → GREEN

격리된 임시 workspace와 fake `pnpm` child만 사용해 실제 verifier 파일의 복사본을 Node subprocess로 실행했다.

- RED: focused 12개 중 7개 실패
  - SIGINT 원본 복원/종료 코드 실패
  - SIGTERM 원본 복원/종료 코드 실패
  - 동시 실행이 두 번째 child command와 `dist/` rename을 시작함
  - active lock을 무시함
  - stale `run-*`을 무시함
  - generated sweep 실패 후 recovery 경로 검증 실패
  - 개별 restore 실패 후 recovery 경로 검증 실패
- GREEN: `pnpm exec vitest run packages/core/test/clean-workspace-verifier.test.ts` → 12/12 통과

회귀 테스트는 동시 실행의 두 번째 프로세스가 command를 한 번도 실행하지 않고 `dist/` rename도 하지 않았음을 별도 로그로 확인한다. 신호 테스트는 child command 실행 중 실제 SIGINT/SIGTERM을 전달하고 원본 snapshot, staging 정리, 신호별 종료 코드를 검증한다. sweep/restore 실패 테스트는 실패하지 않은 다른 원본이 계속 복원되고 실패한 원본 backup이 해당 run에 남는지 확인한다.

## 자기리뷰

- 잠금 생성과 stale 검사 모두 최초 `dist/` 이동보다 앞선다.
- 잠금 획득 실패 실행은 lock, run, command, `dist/` 변경을 수행하지 않는다.
- 신호 핸들러는 즉시 프로세스를 종료하지 않고 child 종료를 유도하며, 기존 `finally`가 끝난 뒤 종료 상태를 설정한다.
- cleanup 대상은 현재 실행이 기록한 `backupDirectory`와 실제 획득한 `active.lock`으로 한정된다.
- 복원 오류가 있으면 run 삭제 조건이 성립하지 않아 recovery data가 보존된다.
- 기존 `prepareOutputs` 독립 오라클, test exact-set 검증, repository-local same-filesystem staging은 변경하지 않았다.
- SQL, LLM trust boundary, shell interpolation, enum, 외부 상태 변경은 이번 diff에 없다.

## 검증

- focused Vitest: 1 file, 12 tests 통과
- `pnpm run verify:clean`: 47 files, 692 tests 통과
- `pnpm typecheck`: 루트와 test typecheck 통과
- `git diff --check`: 최종 커밋 직전 실행

## 안전 확인

변경 범위는 verifier, 해당 회귀 테스트, 이 보고서뿐이다. 테스트 실패 주입은 격리 임시 workspace와 fake child 안에서만 수행했다. 보호 경로는 수정·stage·restore하지 않았고, Slack·Telegram·Tailscale·launchd·Orca credential/config·Keychain 및 `security` 명령은 사용하지 않았다.
