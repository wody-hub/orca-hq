# Task 2 — Trusted local operations bridge

Status: fix round 1 implemented and verified; independent re-review pending. Task 1 final Spec/Quality review is complete/PASS; Task 3 remains pending.

## Constructor and runtime wiring

- `startManagedRuntime` constructs `OperationsOrca` with the trusted configured executable and shutdown AbortSignal; passes real `progressStore`, `progress.submit`, admission snapshot/attempts, and config/env/default capacity provenance to `startManagedService`.
- `startManagedService({operations})` constructs `OperationsJournal` on its existing managed-control SQLite connection, `OperationsService`, and `OperationsHttp`; the existing listener remains `127.0.0.1` and `/health` keeps its prior shape.
- `OperationsService` extends focused `OperationsControls`; schemas/sanitization live in `operations-projections.ts`. No UI, installer, capacity write, viewer lease, private Orca API, or direct terminal-control route was added.
- Owner-only `control.sock` adds exactly `POST /v1/operations/session` with `{}` → `{url,expiresAt}`. The URL is `http://127.0.0.1:<port>/#claim=<single-use-token>`; SPA/launcher consumption remains Task 3/4.

## Final route matrix for frontend

All paths below are relative to `/api/operations`, except auth. Reads require the session cookie. Writes require exact Origin, JSON, cookie, `X-CSRF-Token`, and `Idempotency-Key` (1–100 safe ID characters).
All operation writes return `OperationsMutationReceipt`; accepted → HTTP 202, rejected → 409, unknown → 502. Accepted never means completed. Auth/validation errors use `{error:<machine_code>}`.

| Method/path | Input | Output |
|---|---|---|
| POST `/auth/local/claim` | `{claim}` | `{csrf,expiresAt}` + `hq_operations` cookie |
| POST `/auth/local/refresh` | `{}` + cookie/CSRF/Origin; no idempotency key needed | Rotated `{csrf,expiresAt}`; original session deadline unchanged |
| GET `/status` | none | Task 1 `OperationsStatus`; unavailable metrics, HQ-only occupancy, advertised Orca capabilities and gated `features.controls` support |
| GET `/hq/contexts` | `sessionId?`, numeric-offset `cursor?` | `HqContextPage`: `{contexts,cursor?}`; max 100 current snapshots |
| GET `/hq/contexts/:id` | exact context ID | `{source:"hq",context,evidence}` |
| GET `/hq/requests/:id` | exact request ID | `{source:"hq",request,evidence}` |
| GET `/hq/events` | `contextId?`, `after=0`, `limit=100` (max 500) | `HqEventPage`: events, snapshots, cursor, compacted, oldestSeq/latestSeq |
| GET `/hq/questions` | `after=0`, `limit=100` (max 100 event rows) | `{source:"hq",questions,cursor,compacted}`; continue event cursor until unchanged; current request/native-answer state filters questions |
| POST `/hq/requests` | `{requestId,sessionId,text,contextHint?}`; text 1–8000 raw characters | Receipt; `requestId` must equal Idempotency-Key; existing HQ submission handles new/continue/clarification/answer |
| GET `/orca/runs` | `cursor?` | `{source:"orca",runs,nextCursor?,...publicFields,evidence}` |
| GET `/orca/runs/:id` | exact Run ID | `{source:"orca",run,evidence}` |
| GET `/orca/tasks` | required `runId` | `{source:"orca",tasks,...publicFields,evidence}`; native `run_id`, `status`, creation provenance preserved |
| GET `/orca/workers` | `runId?`, `cursor?` | `{source:"orca",workers,page,scope,...publicFields,evidence}`; native projection/stage/outcome kept separate |
| GET `/orca/workers/:id` | Dispatch ID | `{source:"orca",dispatch,worker,projection,observation,terminal,terminalResource,evidence}` |
| GET `/orca/workers/:id/output` | required `source=terminal|transcript`, `cursor?`, `limit=100` (max 500) | Task 1 `OrcaOutputPage`; terminal `lines` XOR transcript `messages`; source change → 409 |
| GET `/orca/questions` | none | `{source:"orca",messages,count,support,evidence}`; fresh non-consuming inbox question messages; count is the original inbox count |
| GET `/orca/resources` | optional `projectId` to narrow inventory | `{source:"orca",projects,evidence}` with nested setups/worktrees/terminals and public hostScope/truncation evidence |
| POST `/orca/dispatches` | `{taskId,runId,terminalHandle,expectedIncarnation}` | Receipt for typed public dispatch |
| POST `/orca/followups` | `{dispatchId,runId,expectedIncarnation,body}` | Receipt for typed status send to exact Dispatch |
| POST `/orca/replies` | `{messageId,runId,body}` | Receipt; stored native HQ questions submit `/answer` through HQ; external questions use public reply |
| POST `/orca/workers/:id/stop` | `{runId,expectedIncarnation}` | Receipt after exact live/live gate |
| POST `/orca/workers/:id/retain` | `{runId,expectedIncarnation}` | Receipt after exact owned/retained resource gate and known live or settled evidence |
| POST `/orca/workers/:id/release` | `{runId,expectedIncarnation}` | Receipt after exact settled/releasable resource gate |

Body fields are strict; browser `from`, executable, environment, argv, and extra authority fields fail validation. `expectedIncarnation` comes from the displayed public `terminal.incarnationId`; the server re-reads it before effect. Public cursors accept up to 2048 characters.

Examples:
```json
{"requestId":"request_01","sessionId":"session_01","text":"Continue the existing work","contextHint":{"mode":"continue","contextId":"ctx_01"}}
{"dispatchId":"ctx_dispatch","runId":"run_01","expectedIncarnation":"inc_01","body":"Run the focused tests"}
{"requestId":"request_02","action":"followup","targetId":"ctx_dispatch","state":"accepted","observedAt":"2026-09-15T09:00:00.000Z"}
```
The first request uses Idempotency-Key `request_01`; the followup example uses `request_02`.

## Deliberate source-compatible refinements and evidence

- Actual Orca 1.4.203 Run records have `coordinator_handle` and `consumer_generation` but no Run status. Worker detail uses `dispatch.runId/taskId/processIncarnation`, `worker.dispatchId/agentTerminalHandle`, `projection.liveness`, and `terminal.incarnationId`. Task 2 preserves those native fields instead of manufacturing the stricter Task 1 presentation aliases/statuses; frontend must consume the matrix above.
- Added `operations_show_worker` and an operations-specific receipt parser, preserving legacy `show_worker`; adapter and operations port both fence requested Dispatch identity. Explicit typed `senderHandle`/`runId` are optional adapter extensions for source compatibility, but server controls always supply them on dispatch/reply/send.
- Evidence: read-only current Run/worker/terminal/task-list/status/worker-read probes and public command help on 1.4.203. `reply`, `send`, and `dispatch` advertise `--from/--run`; worker stop/retain/release do not, so no unsupported flags are invented. Worker-read's outer cursor is the opaque resumable cursor, unlike the inner terminal position.
- Monitoring calls only public `inbox --limit 100`; it never consumes/acks. Public inbox lacks authoritative pending-question state, so `support.pendingState={supported:false,reason:"inbox_has_no_authoritative_pending_question_state"}` is explicit and no pending status is inferred.
- Controls require ready/reachable tested 1.4.x (patch >=203), contract/stop-verdict capabilities, stable runtime ID, fresh Run ownership, and connected/writable local sender. Because Run has no incarnation field, a fresh same-Run task creation record must match sender handle + `ptyId:incarnationId` + Run generation; absence yields `sender_incarnation_unverifiable`.
- Sender and target evidence is checked again before effect. Worker ownership, Dispatch/Task/Run IDs, endpoint incarnation, resource release state, projection and PTY liveness are distinct gates. Unknown/unverifiable/transferred/release-pending states never authorize controls or free admission capacity. Remote lifecycle controls lack this local exact-incarnation proof and remain inspect-only.
- Inventory has 100-row per-list bounds, four concurrent CLI calls, and a 100-read aggregate request budget. Budget omissions carry `supported:false,reason:"request_read_budget_exhausted"`; public host omissions/truncation survive. Public commands without paging cannot expose unbounded inventories; oversize/malformed receipts fail closed.

## Durability and security

- Journal inserts prepared intent before effects, serializes concurrent requests, hashes canonical input, rejects key/action/target/digest collisions, persists accepted/rejected/unknown, and recovers interrupted intents as unknown. Stored columns contain only request/action/target/digest/state/bounded machine detail/time; no text body, transcript, cookie, CSRF, or raw exception.
- Known pre-effect rejections are rejected; timeout, invalid/mismatched receipt, runtime change after effect, unknown verdict, and other ambiguous effects stay unknown and replay unchanged. Every public mutation uses the HTTP key as `--retry-request`.
- Claim: single use, 60 seconds, owner socket only. Session: 30 minutes, memory only, HttpOnly/SameSite=Strict/Path=/; peer/Host/exact-Origin checks, CSRF, 16-KiB body cap, 2-MiB process/HTTP output caps, no-store/nosniff/CSP/referrer protections. Processes use existing shell:false bounded environment/termination code; read timeout 10s, effect timeout 75s.

## Verification and concerns

- TDD regressions cover journal duplicates/collision/recovery, owner auth, real listener/socket/DB wiring, lease coexistence, native answer routing, capability/runtime/incarnation replacement, exact-worker denial matrix, ambiguous receipts, source tags, redaction, paging/compaction/receipt links, cursor bounds, and bounded inventory. All control effects use fake ports or fake executable fixtures; no real agent was mutated.
- Final focused + impacted run: **11 files, 110 tests passed** (four new operations tests plus managed-control/service/runtime/progress-control and adapter operations/capabilities/process).
- Gateway source typecheck passed; adapter build/source check passed; direct strict NodeNext checks passed for new/changed gateway tests. The 37 affected adapter/managed tests passed again after import cleanup and formatting. Correction: the test-support switch was exhaustive against HEAD's eight operation variants; expanded `OrcaOperation` variants caused TS2366, and importing fake-orca directly only bypassed that integration regression. Fix round 1 resolves it below.
- A failed initial `openProgressStore(:memory:)` test setup chmodded cwd to 0700. Replaced by direct in-memory store construction; restored only cwd to **0755** using the coordinator's recorded pre-task baseline (`msg_aa9be57f3582`) and verified it. No recursive permission change.
- No commit, push, install, restart, protected-document access, or UI/installer edits. Task 3/4 still provide SPA and launcher. Independent Task 2 re-review is next; no claim of broader repository typecheck coverage.
- `task2.diff` is generated from explicit pre-edit snapshots of exact owned paths (including new files); it excludes protected documents and unrelated existing edits. The progress report marks Task 1 reviewed and Task 2 review-ready.

## Fix round 1 — R1/R2/R3

- R1: claim redemption compares the deadline after asynchronous body parsing, with synchronous single-use consumption; session authentication also checks the current deadline after body parsing, with no await before refresh or route invocation. Delayed-body claim, write, and refresh tests each reject at the exact expiry boundary without issuing a cookie or invoking a route.
- R2: empty question pages preserve `after`, advancing to the store's latest sequence when compaction removed later events. Retained pages remain sequential; normal and compacted fixtures verify exhaustion, monotonic cursors, current-question filtering, and three repeated empty polls.
- R3: legacy `LaunchOrca.execute` retains all eight existing cases and explicitly rejects unsupported operations instead of resolving undefined. Two new operation variants exercise rejection, with a subsequent legacy read proving continued operation; existing pilot/provider-failure consumers pass.
- Red phase: **7 new cases failed for the expected defects; 41 existing cases passed**. Green: **48 tests / 3 files passed** (`operations-http`, `operations-service`, new `fake-agents`); **26 tests / 5 files passed** (`operations-journal`, `operations-orca`, `managed-service`, `provider-failures`, `private-pilot`). Total: **74 tests / 8 files**, including **7 new cases**.
- `pnpm exec tsc -p apps/gateway/tsconfig.json --noEmit --pretty false` and the equivalent `packages/test-support/tsconfig.json` check passed. Direct strict NodeNext checks passed for the three changed/new test files after correcting a test-helper `this` annotation; the HTTP file's **4 tests passed again** afterward.
- `task2-fix1.diff` records only this round's eight owned paths from explicit pre-edit snapshots at `/var/folders/0c/w6zr1lls7nggx4f19l5dxf4h0000gn/T/orca-task2-fix1-06wnbf_2`. Original Task 2 snapshot metadata was not supplied to this round, so `task2.diff` remains the original implementation artifact; consume it together with `task2-fix1.diff`.
- R1/R2/R3 are implemented; the historical BLOCK review remains intact for independent re-review. Task 3 has not started.
