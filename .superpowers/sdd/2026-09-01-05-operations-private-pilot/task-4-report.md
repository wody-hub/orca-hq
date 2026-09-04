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

## Fix round 2/5

### 결과

신규 Important `N1`~`N3`만 수정했다. secret-free `pilot.json` 스키마에 절대 `databasePath`를 추가하고 shared core helper가 config 위치(`XDG_CONFIG_HOME ?? ~/.config`), 기본 Application Support data/database 위치, parsing을 단일화했다. setup과 doctor, gateway host, lifecycle 기본 factory가 이 정본을 함께 소비하며 gateway runtime database와 pilot 설정이 다르거나 lifecycle 설정이 누락·legacy·malformed·상대 경로·data 경계 밖이면 외부 mutation 전에 고정 오류로 fail-closed 한다.

uninstall은 program 삭제에도 exact path confirmation을 요구한다. 무인자 기본 호출은 program 절대 경로·문구·shell-quoted 재실행 명령만 출력하고 exit 2로 끝나며, `--remove-data` preview는 program/data 두 경로와 더 강한 결합 문구를 출력한다. service도 두 문구를 독립 검증하고 root, top-level, home/protected ancestor, overlap, out-of-data database, control-character target을 거부한다. 기본 확인 성공은 program만 삭제하고 data/config/Keychain을 보존한다.

### TDD RED 증거

- `N1/N3`: `pnpm test packages/installer/test/lifecycle-host.test.ts packages/installer/test/setup.test.ts` — exit 1. 신규 production factory 4건은 `createDefaultLifecycleHostComposition is not a function`, setup은 기대한 `databasePath` 누락으로 실패했다.
- `N2`: `pnpm test packages/installer/test/lifecycle-commands.test.ts packages/installer/test/cli.test.ts` — exit 1. 기본 `uninstall`이 preview exit 2가 아니라 즉시 exit 0으로 삭제 service를 호출했고, program confirmation helper/검증이 없으며 `/usr`가 허용되어 9건이 실패했다.
- gateway 정본: `pnpm test apps/gateway/test/entry.test.ts` — exit 1. pilot database와 runtime gateway database가 달라도 host 조합이 resolve되어 불일치 테스트가 실패했다.
- 경로/재실행 보강: `pnpm test packages/installer/test/lifecycle-commands.test.ts packages/installer/test/cli.test.ts` — exit 1. newline program target이 허용되고 `$()` 포함 phrase가 double-quoted 재실행 명령에 그대로 들어가는 2건을 확인했다.

### GREEN 근거

- `N1`: `packages/core/src/pilot-config.ts`, `packages/installer/src/config-files.ts`, `setup.ts`, `host.ts`, `lifecycle-host.ts`, `apps/gateway/src/host.ts`가 한 pilot config schema/path를 사용한다. `lifecycle-host.test.ts`는 custom database에서 update와 confirmed default uninstall이 같은 경로를 총 3회 status 조회하고 update가 성공하는지, 누락/파싱 오류/out-of-data 불일치가 mutation call 0으로 거부되는지 검증한다. `entry.test.ts`는 gateway database mismatch를 조합 전에 거부한다.
- `N2`: `uninstall.ts`가 program-only와 program+data exact phrase 및 보호 경로를 검증하고, `cli.ts`가 확인 없는 두 형태를 preview-only로 처리한다. `lifecycle-commands.test.ts`는 missing/wrong phrase 무변경, exact program 성공/data 보존, exact combined phrase data 삭제, root/home/ancestor/top-level/정규화/control-character 경로 거부를 검증한다. `cli.test.ts`는 두 preview·재실행 명령·confirmed dispatch와 shell metacharacter quoting을 검증한다.
- `N3`: shared `pilotConfigurationPath`가 setup/doctor/lifecycle에 동일한 XDG/fallback 규칙을 제공한다. migration 실패를 주입한 production composition 테스트가 custom XDG config를 backup하고 같은 위치로 restore하며 `~/.config` 잔여 경로를 전혀 선택하지 않음을 검증하고, 별도 fallback 테스트가 `~/.config/orca-hq/pilot.json`을 고정한다.

### 변경 파일

- 공유 설정/배선: `packages/core/src/pilot-config.ts`, `packages/core/src/index.ts`, `packages/installer/src/config-files.ts`, `setup.ts`, `host.ts`, `lifecycle-host.ts`, `cli.ts`, `uninstall.ts`, `apps/gateway/src/host.ts`.
- 테스트: `packages/installer/test/setup.test.ts`, `host.test.ts`, `lifecycle-host.test.ts`, `lifecycle-commands.test.ts`, `cli.test.ts`, `clean-install.test.ts`, `cli-process.test.ts`, `apps/gateway/test/entry.test.ts`, `end-to-end.test.ts`.
- dependency/build/문서: `packages/installer/package.json`, `package.json`, `pnpm-lock.yaml`, `docs/operations/update-and-rollback.md`, 이 보고서.

### 검증

- focused: `pnpm test packages/installer/test/lifecycle-host.test.ts packages/installer/test/lifecycle-commands.test.ts packages/installer/test/cli.test.ts packages/installer/test/setup.test.ts apps/gateway/test/entry.test.ts` — 5 files, 62 tests 통과.
- installer 전체: `pnpm test packages/installer` — 9 files, 78 tests 통과.
- installer source: `pnpm --filter @orca-hq/installer typecheck` — 통과.
- installer test: `pnpm --filter @orca-hq/installer typecheck:test` — 통과.
- root typecheck: `pnpm typecheck` — 통과.
- 전체 suite: `pnpm test` — 42 files, 633 tests 통과.
- build: `pnpm build` — exit 0. `Scope: 15 of 16 workspace projects`는 root가 재귀 실행 주체라 제외된 표기이며 build 대상 15개 하위 workspace는 모두 `Done`; 실패나 skip 없음.

### Self-review 및 기존 finding 비회귀

- `N1`: config read/parse/path validation은 composition 전에 끝나며 error 원문은 CLI에 노출되지 않는다. custom DB는 update status/backup/schema/migration과 uninstall status가 모두 동일 정본을 쓴다.
- `N2`: preview branch는 service `run()`을 호출하지 않고, service 자체도 active-work 검사와 exact confirmation 뒤에만 launchd/program/data mutation을 둔다. program-only는 data와 별도 XDG config, Keychain을 건드리지 않는다.
- `N3`: config path 문자열은 core helper 한 곳에서 계산하며 backup과 rollback restore가 composition의 동일 path를 공유한다.
- 이전 `C1/I1~I7` 비회귀: update stage/cause/receipt rollback, status rejection 정규화, stop→backup 순서, rollback continuation, active-work uninstall guard, production SQLite/launchd/source adapters, CLI redaction, lifecycle test typecheck는 기존 installer 전체 및 전체 suite에서 유지됐다. 기존 Minor와 이번 범위 밖 `M1~M6`은 재설계하지 않았다.

### 남은 우려

기존 `databasePath` 없는 legacy config는 추측 경로로 진행하지 않고 doctor/lifecycle/gateway에서 fail-closed 하므로, 운영자는 preview를 확인한 뒤 `hq setup`을 다시 실행해 명시적 필드를 기록해야 한다. 실제 Slack·Telegram·Tailscale·Keychain·launchd·운영 SQLite·credential/config는 변경하지 않았고 모든 destructive 외부 경계는 recording fake 또는 임시 디렉터리에서만 검증했다.

원자 커밋 메시지: `fix(operations): align lifecycle paths and confirmations`.

## Fix round 3/5

### 결과

신규 `B1`과 `B3`만 수정했다. current config 파서는 lifecycle의 fail-closed 정본으로 그대로 유지하고, 별도의 strict legacy inspection이 정확한 이전 3필드 config만 `legacy`로 분류한다. doctor는 `config.pilot-schema`를 current `pass`, legacy `warn`, missing·malformed `fail`로 고정 보고하면서 legacy의 credential account 이름과 Registry 경로로 실제 read-only 진단을 계속한다.

setup은 legacy snapshot의 non-secret account 이름과 Registry 경로를 preflight와 확정 config에 보존하고 기본 `databasePath`를 추가한다. credential 입력을 비우면 Keychain secret을 읽거나 다시 쓰지 않으며, 새로 입력한 credential만 Keychain에 저장하고 기존 account 이름과 합친다. lifecycle CLI는 config 오류에만 `hq setup` 생성·마이그레이션 행동을 포함한 고정 문구를 내고, 다른 provider 실패에는 기존 일반 redacted 문구를 유지한다. update의 잘못된 인자와 문법적으로 불가능한 uninstall 인자는 lifecycle config factory 전에 usage exit 2로 거부하며, 실제 경로가 필요한 uninstall preview는 factory를 통과한다.

### TDD RED 증거

- `pnpm test packages/installer/test/doctor.test.ts packages/installer/test/host.test.ts packages/installer/test/setup.test.ts packages/installer/test/cli.test.ts packages/installer/test/lifecycle-host.test.ts` — exit 1, 8건 실패.
- `B1`: 전용 `config.pilot-schema` check가 없어 doctor 단위 테스트와 missing/malformed host 진단이 `undefined`였고, legacy config는 `result.ok=false`로 credential/Registry 실패에 흡수됐다. blank credential setup migration과 신규 credential 병합도 preflight에서 중단됐다.
- `B3`: config factory의 `lifecycle_config_invalid`가 `Lifecycle operation failed.`로 흡수됐고, 잘못된 update/uninstall 구문은 factory 오류 때문에 usage 2 대신 exit 1을 반환했다. preview용 factory 주입도 연결되지 않아 exit 1이었다.
- 첫 GREEN 시도는 `host.ts`의 비동기 기본 인자 문법 오류로 3 suite가 transform 단계에서 멈췄다. `await`를 함수 본문으로 옮긴 뒤 같은 기능 가설로 재검증했다.

### GREEN 근거

- `packages/core/src/pilot-config.ts`는 current strict schema와 별개인 strict `LegacyPilotConfigSchema` 및 `inspectPilotConfigText`를 제공한다. 누락, JSON 파싱 실패, extra field를 포함한 임의 config는 legacy가 아니라 `missing`/`invalid`다. lifecycle은 계속 `parsePilotConfigText`만 사용하므로 마이그레이션 전 update/uninstall fail-closed가 유지된다.
- `packages/installer/src/doctor.ts`와 `host.ts`는 고정 config schema check를 추가했다. legacy credential 진단은 password 출력 옵션 없이 `security find-generic-password`의 account 존재만 확인하고 Registry는 기록된 절대 경로를 읽는다. doctor 경계에는 mutation port 호출이 없다.
- `packages/installer/src/setup.ts`와 `host.ts`는 한 setup 실행에서 읽은 legacy/current non-secret snapshot을 preflight와 config 생성에 재사용한다. blank credential migration은 Keychain write 0, 기존 account/path 보존, 기본 database 기록을 단언하며 신규 credential fixture는 새 값 1건만 Keychain에 쓰고 account 이름을 병합함을 단언한다.
- `packages/installer/src/cli.ts`는 usage shape를 factory 전에 판정하고, config 오류 코드에만 고정 migration 행동을 노출한다. CLI 테스트는 update와 uninstall config 오류 양쪽에서 secret/path 원문 부재, 일반 provider 문구 비회귀, invalid syntax factory 0회, 두 preview factory 2회를 단언한다.

### 변경 파일

- config/doctor/setup/CLI 구현: `packages/core/src/pilot-config.ts`, `packages/installer/src/doctor.ts`, `host.ts`, `setup.ts`, `cli.ts`.
- 테스트: `packages/installer/test/doctor.test.ts`, `host.test.ts`, `setup.test.ts`, `cli.test.ts`, `lifecycle-host.test.ts`.
- 운영 문서/보고: `docs/operations/update-and-rollback.md`, 이 보고서.

### 검증

- focused: 5 files, 39 tests 통과.
- installer 전체: 9 files, 86 tests 통과.
- installer source typecheck와 installer test typecheck: 모두 통과.
- root typecheck: 통과.
- 전체 suite: 42 files, 641 tests 통과.
- build: exit 0, root 실행 주체를 제외한 15개 workspace project 모두 `Done`.
- `git diff --check`: 통과.

### Self-review 및 비회귀

- `B1`: legacy 판정은 exact strict schema 하나에만 열려 있고 doctor의 고정 경고와 setup migration이 같은 non-secret snapshot을 사용한다. setup은 confirmation 전에는 config/Keychain을 변경하지 않으며 기존 secret 조회·복사 경로가 없다.
- `B3`: CLI는 오류 객체의 code만 비교하고 message/cause/path를 출력하지 않는다. 일반 provider redaction은 기존 테스트가 유지하며 preview에는 canonical program/data path가 필요하므로 안전한 factory 통과 계약도 유지한다.
- `N1`: current `databasePath`는 여전히 gateway/lifecycle 정본이고 legacy에는 추측 database를 제공하지 않는다. `N2`: uninstall 서비스의 active-work, exact confirmation, 보호 경로 검사는 변경하지 않았다. `N3`: setup/doctor/lifecycle의 XDG-aware config path helper와 backup/restore 경로는 그대로 유지됐다. 전체 installer 및 repository suite가 기존 회귀 테스트를 모두 통과했다.

### 남은 우려

실제 Slack·Telegram·Tailscale·Keychain·launchd·운영 SQLite·Orca credential/config는 변경하지 않았다. 테스트의 credential 확인과 저장은 recording machine 경계만 사용했고 secret 원문은 config/CLI 출력에 포함되지 않았다. `B2`, `B4`, `B5`와 이전 deferred Minor는 계약대로 이번 범위에서 재설계하지 않았다.

원자 커밋 메시지: `fix(installer): support safe config migration`.
