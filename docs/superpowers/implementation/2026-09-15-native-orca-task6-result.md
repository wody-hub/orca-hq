# Task 6 Result — Migration and recovery acceptance (2026-09-15)

Status: **complete for Task 6's source-level migration/recovery acceptance**. This
work did not install, restart, or exercise the production service and did not start
real Orca workers; those live checks remain Task 7.

Schema clarification (coordinator-approved scope adjustment): this implementation
reuses idempotent capability/column detection (`PRAGMA table_info`) and an additive
`ALTER TABLE` migration for `execution_backend`; it introduces no numeric global
schema-version marker, and no such marker is claimed here. Task 7 should assess
compatibility of this additive migration.

## Implemented behavior

1. `request_contexts.execution_backend` is an additive, per-assignment discriminator:
   `legacy_conversation | native_orca`. Existing databases are backfilled to
   `legacy_conversation`; new native-runtime assignments are written as `native_orca`.
   Assignment identity is immutable, so reopening a pre-discriminator assigned row in
   native mode fails closed as `recovery_required` instead of replaying it.
2. The combined old-database fixture now seeds completed, active, unknown, already-
   assigned legacy queued, and untouched queued work in real SQLite. On reopen it proves:
   completed/active/unknown attempts keep their original rows and dispatch identity;
   no replacement is launched; the assigned legacy queued row is not converted or
   replayed; and the untouched queued request receives one new native assignment and one
   launch. A legacy provider thread is present in the old context and is never used as a
   native `resumeTerminalHandle`.
3. Recovery admission is gated by the persisted coordinator barrier. The fixture observes
   `hq_worker_coordinator.ready = 0` before native reconciliation and `ready = 1` only
   afterward; active and unknown rows remain occupancy-bearing throughout.
4. `tests/e2e/native-orca-progress.spec.ts` composes the real managed Unix socket,
   `createProgressClient`, `createManagedNativeRuntime`, native coordinator, worker
   admission, and an actual SQLite database with an isolated `FixtureNativeRelay`.
   Its eight tests cover:
   - two independent contexts and isolated results;
   - a same-context followup;
   - retained-terminal reacquisition by the same context/project/profile;
   - mixed terminal/Slack/Telegram composition sharing the default 10-worker limit, with
     ten held concurrently and the eleventh launching only after one settles;
   - failed native result isolation;
   - stop with exact fake stop proof, cleanup, settlement, and capacity return;
   - receipt-free unknown launch retaining occupancy and preventing replacement;
   - gateway close/reopen with exact live Dispatch observation and eventual result
     reconciliation without a second launch.
5. The legacy real-socket e2e now asserts all seven exercised assignments remain
   `legacy_conversation`.
6. The isolated gateway declaration check exposed TS4058 because the exported
   `createManagedNativeRuntime()` return type referenced private `QuestionRecord`.
   Exporting that interface is the minimal declaration-safe type fix.

## Verification evidence

Commands below were run from the workspace root on 2026-09-15 KST:

```text
pnpm exec vitest run tests/e2e/native-orca-progress.spec.ts
# 1 file / 8 tests passed

pnpm exec vitest run tests/e2e/native-orca-progress.spec.ts tests/e2e/context-progress.spec.ts \
  apps/gateway/test/progress-store.test.ts apps/gateway/test/restart-fixture.test.ts \
  apps/gateway/test/managed-service.test.ts apps/gateway/test/native-coordinator.test.ts \
  apps/gateway/test/progress-runtime.test.ts apps/gateway/test/worker-admission.test.ts
# 8 files / 110 tests passed

pnpm typecheck
# passed, including root/tests and workspace test typechecks

pnpm test
# 93 files / 1231 tests passed

pnpm --filter './packages/**' --filter './apps/**' --if-present run build
# passed; Scope: 15 of 16 workspace projects
```

The final build command is the safe workspace-local equivalent of `pnpm -r build`.
The root `prepare` script was inspected first and deliberately not invoked because it
runs `packages/installer/bin/install-global.js`; every package/app build artifact was
still covered, including gateway and web.

## Exact changed-file allowlist

- `apps/gateway/src/progress-store.ts`
- `apps/gateway/src/progress-runtime.ts`
- `apps/gateway/src/native-coordinator.ts`
- `apps/gateway/test/progress-store.test.ts`
- `tests/e2e/context-progress.spec.ts`
- `tests/e2e/native-orca-progress.spec.ts`
- `docs/superpowers/implementation/2026-09-08-native-orca-migration.md`
- `docs/superpowers/implementation/2026-09-15-native-orca-task6-result.md`
- `docs/superpowers/implementation/2026-09-09-native-orca-handoff.md`
- `docs/superpowers/implementation/2026-09-08-native-orca-implementation-status.md`
- `docs/superpowers/plans/2026-09-08-hq-native-orca-agents.md`

No commit, push, install, production restart, external message, or real production test
worker was performed. The shared Task 5 and prior-worker edits were preserved.

## Remaining limitations

Task 7 still owns independent review and live installed acceptance: actual HQ endpoint,
real Orca Task/Dispatch, GUI/terminal visibility, and operator-observed production health.
The legacy web-monitoring/quarantine/multi-viewer/sanitization follow-ups recorded in the
Task 5 handoff remain separate and were not pulled into Task 6.
