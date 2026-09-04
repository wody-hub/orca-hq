# Task 4 implementation report

## Outcome

Implemented timestamped SQLite backup orchestration, guarded source updates with rollback, and safe uninstall behavior. The implementation is port-driven, so tests exercise only in-memory recording fakes and do not mutate launchd, a real database, a source checkout, Application Support, Keychain, or any other external host state.

## Delivered files

- `packages/installer/src/backup.ts`
  - Timestamp-derived backup directories and receipts.
  - SQLite online backup and restore ports.
  - Optional configuration snapshot with secrets forbidden by type and runtime guard.
  - Source revision and schema version recorded in the receipt/manifest.
- `packages/installer/src/update.ts`
  - Active/uncertain work checks that fail closed, including malformed status.
  - Explicit revision verification, frozen-lockfile installation, and read-only preflight.
  - Online backup before the maintenance stop, followed by a second work-status check.
  - Migration/start/doctor success path.
  - Best-effort ordered rollback of gateway, prior revision, database/config, and prior gateway restart.
  - Failure result exposes the exact backup receipt and rollback completeness.
- `packages/installer/src/uninstall.ts`
  - Default service/program removal with durable data preservation.
  - Exact normalized path phrase for separately confirmed data removal.
  - Rejection of root, relative, overlapping program/data, and out-of-data database paths.
- `packages/installer/src/index.ts`
  - Public exports for lifecycle modules.
- `packages/installer/test/lifecycle-commands.test.ts`
  - Backup, update ordering/guards/rollback, and uninstall preservation/confirmation coverage.
- `docs/operations/update-and-rollback.md`
  - Operator contract, rollback sequence, receipt handling, reinstall preservation, and safe uninstall guidance.

## TDD evidence

1. Initial RED: `pnpm test packages/installer/test/lifecycle-commands.test.ts` failed because `../src/backup.js` did not exist.
2. Initial GREEN: the new lifecycle modules made 8 targeted tests pass.
3. Review RED/GREEN cycles:
   - A program path nested inside durable data was accepted; the new test failed, then passed after symmetric path-overlap validation.
   - Full update stopped the gateway before online backup; the ordering test failed, then passed after moving full-update backup before the maintenance stop while retaining the brief's standalone `prepareUpdate` contract.
   - Undefined revision verification and preflight results allowed updates; two tests failed, then passed after requiring explicit `true`/`ok: true` results.
   - The real backup restore test was mutation-checked by temporarily removing restore effects; it failed with an empty call record and passed again after restoring the implementation.

## Self-review

- Scope matched the Task 4 brief: lifecycle modules, focused tests, public exports, and the requested operations document/report.
- Critical safety review covered data paths, check/stop race windows, revision/preflight trust boundaries, rollback continuation, and secret exclusion.
- Fixes applied during review: symmetric program/data separation, backup-before-stop ordering in full update, fail-closed revision/preflight results, and direct restore coverage.
- No SQL construction, shell invocation, process-wide kill, broad filesystem deletion, or LLM-derived input was introduced.
- Existing unrelated worktree changes were left untouched and are not part of the Task 4 commit.

## Verification

`pnpm test packages/installer && pnpm typecheck` completed successfully:

- 8 installer test files passed.
- 46 installer tests passed.
- Repository TypeScript typecheck passed with no errors.

## Commit

Atomic commit message: `feat(operations): add safe update and uninstall`.

## Fix round 1/5

### 결과

독립 리뷰의 Critical `C1` 1건과 Important `I1`~`I7` 7건을 모두 수정했다. 업데이트는 source 설치가 시작된 뒤 발생하는 모든 실패를 안정적인 `stage`와 원래 `cause`를 가진 `UpdateFailedError`로 보존하며, receipt가 없으면 이전 program/dependency와 필요 시 gateway만 축소 복구하고 receipt가 있으면 program/config/database/gateway 전체를 호환 상태로 복구한다. CLI와 macOS production lifecycle 조합은 모든 외부 변경을 명시적 process/filesystem/SQLite/launchd 포트 뒤에 두었고 테스트에서는 recording fake만 사용했다.

### Finding별 TDD 근거

- `C1`
  - covering test: `restores the prior program when preflight fails before a backup exists`, `restores the prior program when the second active-work check closes the maintenance window`, `restores and restarts the prior program when backup creation fails after stop`.
  - RED 이유: preflight 오류와 backup 오류는 원 오류를 그대로 던졌고 source restore가 없었으며, 2차 active-work는 `UpdateBlockedError`만 반환해 새 revision을 남겼다.
  - GREEN: source 설치부터 try/catch 경계를 열고 receipt 유무 및 gateway stop 여부에 따라 축소/전체 rollback을 선택했다.
- `I1`
  - covering test: `normalizes gateway status rejection to active_work`.
  - RED 이유: `gateway.status()` rejection의 provider 원문이 그대로 노출됐다.
  - GREEN: 공통 `assertNoActiveWork`가 status rejection을 `active_work`로 정규화한다.
- `I2`
  - covering test: `prepares a stopped gateway backup without including secrets`, `verifies, installs, preflights, backs up, migrates, starts, and diagnoses in order`.
  - RED 이유: 전체 update가 `online backup → gateway stop` 순서여서 공개 `prepareUpdate`와 불일치하고 backup 이후 쓰기 손실 창구가 있었다.
  - GREEN: `createUpdate.run()`도 동일 preparation 구현을 사용해 `2차 status → gateway stop → online backup`을 정본으로 삼는다.
- `I3`
  - covering test: migration rollback 테스트가 `stage: "migration"`과 동일 cause 객체를 단언하고, CLI redaction 테스트가 cause 원문 비노출을 단언한다.
  - RED 이유: 기존 `catch {}`가 실패 원인을 폐기했고 단계 식별자가 없었다.
  - GREEN: `UpdateFailedError`가 `stage`, `cause`, optional `backup`, `rollbackComplete`를 보존하고 CLI는 고정 문구만 출력한다.
- `I4`
  - covering test: malformed/negative/NaN/aggregate-component contradiction table, status rejection, `marks rollback incomplete when a production restore stage fails and still attempts the remainder`.
  - RED 이유: aggregate 0과 component 1의 모순을 idle로 허용했고 rollback 실패 분기는 실행되지 않았다.
  - GREEN: 상태 표현이 함께 오면 합계 일치를 요구하며, 한 rollback 단계가 실패해도 나머지를 실행하고 `rollbackComplete=false`를 반환한다.
- `I5`
  - covering test: uninstall의 active/malformed/contradictory/unavailable status table과 기본 data 보존 테스트.
  - RED 이유: uninstall이 gateway status를 읽지 않고 즉시 launchd/program을 제거했다.
  - GREEN: confirmation 및 모든 launchd/filesystem 변경 전에 공통 active-work guard를 실행한다.
- `I6`
  - covering test: CLI update/uninstall dispatch 및 redaction 테스트, `production lifecycle host composition`의 source/frozen install/read-only preflight/SQLite/schema/launchd/filesystem 포트 테스트, exact launchd uninstall 테스트.
  - RED 이유: CLI가 reserved 문구와 exit 1로 끝났고 production 조합 및 launchd plist 제거 API가 없었다.
  - GREEN: `lifecycle-host.ts`가 full SHA 확인, detached checkout, frozen pnpm install, no-emit typecheck, SQLite online backup/restore와 schema/status 조회, 새 revision migration child process, exact LaunchAgent 및 파일 경계를 조합한다. 운영 문서를 실제 `pnpm hq update --revision <full-commit-sha>`와 `pnpm hq uninstall [--remove-data --confirm <exact-phrase>]` 동작에 맞췄다.
- `I7`
  - covering config: `packages/installer/tsconfig.test.json`과 `pnpm --filter @orca-hq/installer typecheck:test`.
  - RED 이유: installer 전체 테스트를 곧바로 포함하면 기존 무관 오류 14건이 발생했고, lifecycle fixture의 readonly mutation 및 의도적 undefined 응답이 타입 검사되지 않았다.
  - GREEN: 이번 lifecycle/CLI/launchd 테스트만 포함하는 좁은 전용 구성을 추가했다. 의도적 undefined fixture 두 곳은 이유 주석과 `unknown` 경유 unsafe cast를 명시했고 나머지 fake는 실제 포트 타입을 충족한다.

### 추가 self-review 보완

- aggregate status와 `uncertainDispatches`만 모순되는 변형을 추가로 RED 확인한 뒤 fail-closed 처리했다.
- production source fake가 checkout 후 HEAD를 실제로 변경하도록 고쳐, backup receipt가 새 revision이 아니라 백업된 DB/config와 호환되는 이전 revision을 기록하는지 RED→GREEN으로 확인했다.
- launchd port 확장으로 영향을 받은 gateway restart fixture에 exact plist 제거 fake를 추가해 루트 타입 계약을 유지했다.

### 변경 파일

- lifecycle 구현/배선: `packages/installer/src/update.ts`, `uninstall.ts`, `launchd.ts`, `lifecycle-host.ts`, `cli.ts`, `index.ts`.
- 테스트/타입 구성: `packages/installer/test/lifecycle-commands.test.ts`, `lifecycle-host.test.ts`, `cli.test.ts`, `launchd.test.ts`, `packages/installer/tsconfig.test.json`, `apps/gateway/test/restart-fixture.test.ts`.
- dependency/문서/보고: `packages/installer/package.json`, `pnpm-lock.yaml`, `docs/operations/update-and-rollback.md`, 이 보고서.

### GREEN 검증

- focused: `pnpm test packages/installer/test/lifecycle-commands.test.ts packages/installer/test/launchd.test.ts packages/installer/test/cli.test.ts packages/installer/test/lifecycle-host.test.ts` — 4 files, 49 tests 통과.
- installer: `pnpm test packages/installer` — 9 files, 66 tests 통과.
- 신규 test 타입: `pnpm --filter @orca-hq/installer typecheck:test` — 통과.
- root typecheck: `pnpm typecheck` — 통과.
- build: `pnpm build` — 15/16 workspace project build 통과.
- 전체 suite: `pnpm test` — 42 files, 620 tests 통과.

### 우려사항

실제 Mac, credential, Keychain, launchd service, 운영 SQLite 또는 source checkout은 테스트에서 변경하지 않았다. production migration은 새 checkout의 persistence package를 먼저 build한 뒤 별도 Node process에서 실행하므로, 해당 build/process가 실패하면 기록된 `migration` 단계에서 full rollback이 수행된다. 이번 수정 범위 밖 Minor 12건은 의도적으로 남겼다.

원자 커밋 메시지: `fix(operations): harden safe lifecycle commands`.
