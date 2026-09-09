# HQ runtime retention and review fixes

Dispatch: task_fd9d1831ff0a / ctx_b7309770a1ba.
Scope expanded by coordinator inbox to runtime review findings 1, 4, and 6; relay/compatibility findings 2, 3, and 5 remain owned by another dispatched worker.

## Files changed

- apps/gateway/src/progress-runtime.ts
- apps/gateway/src/progress-store.ts
- apps/gateway/test/progress-runtime.test.ts
- apps/gateway/test/progress-store.test.ts

No installer, core, relay, compatibility, installed application, or coordinator-owned test changes. No live model sessions, native workers, deployment, installation, commits, or pushes.

## Retention

Production runtime now sweeps completed detail at startup and hourly, using a 30-day cutoff. Each immediate SQLite transaction deletes at most 1,000 events, so backlog processing does not loop on user execution's path. The timer is unreferenced and cleared on close. Failed retention rolls back both deletion and compaction watermarks, emits a fixed diagnostic without underlying storage details, and retries on the next hourly pass without aborting or replaying user work.

Eligibility remains completed/failed requests only, excludes acceptance receipts, and additionally excludes every request with any acquired or recovery-required reservation. Stale heartbeats never imply release. Released reservation rows, original result snapshots, assignment outcomes, job links, and acceptance receipts remain durable. Exact duplicate completion after detail pruning returns the original result without rebuilding display history; conflicting results remain rejected. The reservation lookup has an owner/request/state index.

## Full retry resource provenance

Existing normalized reservation rows are retained as durable native-attempt resource provenance. Retry and worker-spawning followup already enter the runtime through beforeNative(jobId); that path now requires an exact job/dispatch/request link and one unambiguous reservation identity, validates execution identity when present, and atomically reacquires every stored primary, secondary, and external resource with its recorded access mode. It never falls back to the primary checkout alone.

Missing, ambiguous, or mismatched provenance rejects before launch and marks recovery required. Tests close and reopen real SQLite before retry, hold secondary or external resources in another context, verify no partial acquisition/no launch, then release and verify the entire resource set is reacquired. A related startup guard prevents task-level observations with a different dispatch from rebinding an old request or aborting startup; ambiguous ownership remains retained for recovery. Relay/native API signatures are unchanged.

## Multipart outcomes

The request_contexts table gains nullable outcome_json through an additive migration. ProgressStore adds completeAssignment and optional RequestContextAssignment.outcome; the outcome contains state, text, and optional job IDs. Its transaction persists a part's own final event and durable outcome atomically, without finishing the aggregate request. Replays remain idempotent after display-event compaction.

Execution uses Promise.allSettled. Each part finishes its own context view promptly, and the aggregate is emitted once after all parts settle, in assignment order, with per-part labels distinguishing completed, failed, and recovery-required effects. Thrown failures use a safe message; raw provider diagnostics are excluded. Unknown native effects cannot be reported as completed simply because the HQ response returned normally. A previously settled durable assignment is skipped rather than rerun when an assigned classification is resumed.

## Verification

- New regressions were run red before fixes: held native detail was pruned, pruning exceeded 1,000 events, no production timer existed, completion replay rebuilt pruned history, retry ignored secondary/external conflicts, multipart failures emitted wrong/early aggregate state, and unknown native effects appeared completed.
- Focused runtime/store plus coordinator socket and restart suites passed 42 tests after fixes.
- Full repository pnpm typecheck passed, including root source/test checking and package test checks.
- Gateway production typecheck passed.
- Scoped git diff --check passed.
- Broad gateway plus context-progress socket/restart run at 12:35 passed 294 of 296 tests; both failures were relay-owned concurrent work: orca-relay.test.ts:526 expected failed vs recovery_required, and :711 expected known-worker guidance delivery during stalled creation. These were reported to the coordinator; this report does not claim the concurrent relay corrections are finished.

Final focused run at 12:38 including reservations, executor, HTTP boundary, and coordinator socket/restart suites passed 51 tests across 7 files (exit 0). No assigned fix is left unimplemented; final cross-worker integration and deployment remain with the coordinator.
