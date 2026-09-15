# Native Orca Migration — executionBackend and recovery (Task 6)

Status: COMPLETE for source-level Task 6 acceptance. See
`2026-09-15-native-orca-task6-result.md` for the complete fixture matrix, exact
commands/counts, and the boundary with Task 7 live installed acceptance.

Schema clarification (coordinator-approved scope adjustment): migration reuses the
existing idempotent capability/column detection and applies additive `ALTER TABLE`
when `execution_backend` is absent. No numeric global schema-version marker was
introduced or delivered; Task 7 should assess compatibility of this approach.

## What changed (exact allowlist)

- `apps/gateway/src/progress-store.ts`
  - New exported type `ExecutionBackend = "legacy_conversation" | "native_orca"`.
  - `RequestContextAssignment.executionBackend: ExecutionBackend` (required on read).
  - `AssignRequestContext.executionBackend?: ExecutionBackend` (optional on write,
    defaults to `"legacy_conversation"` inside `assignRequestContext()` so every
    pre-existing caller in the codebase and test suite keeps compiling and behaving
    identically without being touched).
  - `request_contexts` table: new column `execution_backend TEXT NOT NULL DEFAULT
    'legacy_conversation'` (`CHECK` constraint on the `CREATE TABLE` path for fresh
    databases; the `ALTER TABLE ... ADD COLUMN` fallback for pre-existing databases
    omits the `CHECK` to stay inside SQLite's documented `ADD COLUMN` restrictions,
    matching the existing `outcome_json`/`last_seq` additive-migration precedent in
    this file).
  - `assignRequestContext()`: reads/compares/writes `execution_backend`; a mismatch
    on an existing (request_id, part_id) row now also throws
    `ProgressRecordCollisionError`, consistent with how every other field on that
    row is already guarded.
  - `listRequestAssignments()`: selects and maps `execution_backend` →
    `executionBackend`.
- `apps/gateway/src/progress-runtime.ts`
  - `assign()`'s parameter type is `Omit<AssignRequestContext, "executionBackend">`;
    the function itself computes the value from `options.nativeExecution` (already
    the existing runtime-wide native/legacy switch) and injects it before calling
    `store.assignRequestContext()`. This is the single injection point — no
    individual call site needed to change.
  - The one call site that builds `RequestContextAssignment` objects directly
    (rather than through `assign()`, for the in-memory decision-parts map) now also
    sets `executionBackend` the same way.
- `apps/gateway/test/progress-store.test.ts`
  - New `describe("executionBackend migration (Task 6)")` block: real-SQLite reopen
    fixture (see result doc for exact scenario and assertions).
- `tests/e2e/native-orca-progress.spec.ts`
  - Combined old-schema/discriminator plus worker-admission reopen proof and real
    managed-socket acceptance with an isolated fake native relay.
- `tests/e2e/context-progress.spec.ts`
  - The legacy real-socket flow asserts every exercised assignment stays
    `legacy_conversation`.
- `apps/gateway/src/native-coordinator.ts`
  - Exports `QuestionRecord`, fixing exported runtime declarations (TS4058) without
    changing runtime behavior.

The complete changed-file allowlist, including planning/status documents, is in the
Task 6 result.

## Why per-assignment, not per-context

`work_contexts` rows (contexts) can accumulate history across the migration
boundary: a context created before this change keeps `legacy_conversation` history,
and a *new* request can still be routed into that same context as a `continue`
relation while the runtime is native-mode. The discriminator therefore lives on
`request_contexts` (the assignment: one row per `request_id` + `part_id`), never on
`work_contexts`. This also means `work_contexts.thread_id` is untouched and is never
read as a native terminal/session identifier — that invariant was already true
before this change and nothing here alters it.

## Backward compatibility

`executionBackend` is optional on write and defaults to `legacy_conversation`. Every
pre-existing call site of `assignRequestContext()` in production code and across the
test suite (`native-coordinator.test.ts`, `execution-compatibility.test.ts`,
`execution-reservations.test.ts`, `worker-admission.test.ts`,
`progress-runtime.test.ts`, and the rest of `progress-store.test.ts`) was left
unmodified and continues to pass unchanged — verified by running all of them (see
result doc).

## Install / rollback sequence (not executed — for the operator performing the real install)

1. **Backup** before touching anything live: copy the current gateway source tree,
   the current build output, the current config, and the SQLite database file (the
   DB backup must be taken with the process quiesced or via SQLite's own backup API,
   not a raw `cp` of a live-written file).
2. **Preserve active work**: do not stop the running gateway process until the new
   binary is built and verified; do not truncate or replace the DB file while any
   worker attempt is `active`/`unknown` in `hq_worker_coordinator`.
3. **Build** the new gateway with a workspace-local command and confirm the build
   artifacts match the backed-up source (no partial/stale artifact swap). Task 6
   verified all package/app artifacts with
   `pnpm --filter './packages/**' --filter './apps/**' --if-present run build`; do not
   invoke the root `prepare`, which runs the global installer.
4. **Restart**: stop the old process, start the new binary against the *same*
   database file. On start, `native-coordinator.ts`'s `start()` reconciles every
   non-settled attempt via `getNativeLaunch()`/`observeNativeWorker()` (authoritative
   liveness, never PTY-based) into `active` or `unknown` — it never relaunches — and
   only calls `admission.finishReconciliation()` (which flips the SQLite-persisted
   `ready` flag to 1) once that pass completes. `progress-runtime.ts`'s `start()`
   marks any request that was mid-flight as `recovery_required` (or requeues
   classifying-only requests). A requeued request with an existing legacy assignment
   collides on its immutable backend discriminator and fails closed rather than
   entering native execution; an untouched request gets a fresh `native_orca`
   assignment exactly once.
   `managed-service.ts`'s `beforeReady` chains these two `start()` calls before
   flipping the channel-facing `ready` flag, so no new admission or channel message
   is processed until recovery has finished.
5. **Health check**: confirm the new process reports ready, confirm
   `hq_worker_coordinator.ready = 1`, confirm no attempt was replaced (attempt count
   and dispatch IDs for `active`/`unknown` attempts must match pre-restart).
6. **New request**: send one new request through a channel and confirm it is
   admitted and assigned with `executionBackend = 'native_orca'` (or whatever the
   new binary's `nativeExecution` mode is configured to) — the queued-but-untouched
   case from the reopen test is the unit-level proof of this; a live end-to-end
   confirmation is part of the deferred socket e2e suite.
7. **Rollback** (if step 5 or 6 fails): stop admissions first (the epoch-fenced
   `ready` flag on `hq_worker_coordinator` already gates this — do not manually flip
   it back without going through the coordinator's construction path). Preserve the
   *latest* DB file and any native attempts recorded in it — never restore an older
   DB snapshot over a database that has newer live/unknown worker rows in it, since
   that would silently orphan real running native work. If the previous binary is
   schema-incompatible with the column this migration adds (it is not: the column is
   additive with a default, so an older binary that never selects
   `execution_backend` still reads/writes every other column correctly), the correct
   response is to roll forward to a fixed new build, not backward; only reach for an
   explicit compatibility reader if a future migration ever removes or renames a
   column an older binary depends on, which this change does not do.
