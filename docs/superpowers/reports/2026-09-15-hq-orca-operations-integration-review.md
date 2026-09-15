# HQ + Orca Operations Console — final independent integration review

Date: 2026-09-15 KST  
Task 4 Spec: **BLOCK**  
Task 4 Quality: **BLOCK**  
Overall Verdict: **BLOCK**

The owner-session and durable server journal boundaries are substantially implemented, but the console loses its unknown-result guard during ordinary inspection, rejects native terminal inventory, and hides current questions beyond the first event page. The planned dispatch injection behavior and combined fake-process integration acceptance are also incomplete. No implementation fixes were made in this review.

## Scope and evidence policy

Reviewed the approved `docs/superpowers/plans/2026-09-15-hq-orca-operations-implementation.md`, Task 4 report/scoped overlay, final Task 1 fix-2 / Task 2 fix-1 / Task 3 fix-2 independent reviews, relevant Task 2 report, README console guidance, and live contract/process/gateway/web/installer boundaries. Earlier contracts were read only where needed to trace these boundaries. Visually inspected all three supplied 1440/1280/390 screenshots.

Reused the Task 4 recorded evidence as instructed: **1,326 root tests / 104 files**, **37 web tests / 2 files**, **4 Playwright cases**, focused gateway/installer coverage, and full typecheck/build. These are prior execution results, not newly run suites. Fresh execution was limited to three concrete concern probes using fake data, React/JSDOM, the live frontend source, the existing built gateway service, and an isolated in-memory SQLite store; source inspection corroborated the gateway paths. Read-only public Orca dispatch help and its low-level topology guide were used to check the injection contract. No real Orca control was invoked.

## Blocking findings

### R1 — P1: inspecting an unknown mutation discards its identity and enables a new attempt

- **Location:** `apps/web/src/routes/operations-compose.tsx:18` and `:23` keep the request ID and receipt only in the mounted `ReviewedMutation`; `:35` and `:48` guard only that local receipt. `apps/web/src/routes/operations-detail.tsx:92` conditionally mounts the entire controls section only on the state tab. `apps/web/src/app.tsx:47` also keys the screen by route.
- **Trigger:** submit stop on a live/live exact worker; receive `unknown`; switch to the evidence tab to inspect; return to state. This unmounts and remounts the mutation controls while retaining the original worker snapshot.
- **Observed fresh probe:** before inspection, stop was disabled and worker reads were 1; after inspection, stop was enabled, the unknown notice was absent, and worker reads were still 1. Confirming again made a second fake mutation call with a different request ID.
- **Impact:** the prescribed inspect-only workflow itself erases the ambiguity fence. A new ID bypasses journal replay protection and can repeat an unresolved action. Route navigation similarly loses HQ compose uncertainty. This contradicts stable identity / unknown inspect-only requirements and README guidance.
- **Required correction:** retain pending/unknown mutation identity and receipt outside conditional tabs and route component lifetimes; inspection must preserve the guard until an explicit authoritative reconciliation policy resolves it. Verify unknown stop → evidence → state, route departure/return, and unchanged-ID protection. The existing `app.test.tsx:223` test never leaves the mounted form, so it does not prove this requirement.

### R2 — P1: native terminal inventory fails the browser resource schema

- **Location:** `apps/web/src/api.ts:34` and `:73` require terminal `id`; `apps/web/src/routes/operations-resources.tsx:10` renders that field. Native terminals use `handle` at `packages/orca-adapter/src/receipts.ts:235` and `apps/gateway/src/operations-projections.ts:8`; `apps/gateway/src/operations-service.ts:474` and `:486` preserve those native rows.
- **Trigger:** any covered project/worktree returns a terminal row with its documented `handle` and no synthetic `id`.
- **Observed fresh probe:** passed `OperationsService.resources()` output into the live `orcaResourcesSchema`; it threw `malformed_response`. The native row keys were `handle, ptyId, incarnationId, connected, writable, executionHostId, worktreeId`.
- **Impact:** the real nonempty resources screen becomes an error despite a valid gateway response. This is an actual cross-layer contract mismatch, not optional-field compatibility speculation.
- **Required correction:** use the native handle consistently, or define and test an explicit exact-identity projection at the gateway boundary. Feed actual service output to the browser parser in regression coverage. `operations-service.test.ts:778` correctly expects `.handle`, while `operations-console.spec.ts:31` fabricates `{id: "term-1"}`, masking the incompatibility.

### R3 — P2: pending questions after the first 100 events are invisible

- **Location:** `apps/web/src/routes/operations-questions.tsx:20`, `operations-overview.tsx:9`, and `operations-evidence.tsx:9` always call `hqQuestions("0")` and do not consume its cursor. `apps/gateway/src/operations-service.ts:104` bounds the event page before filtering clarification events at `:107`.
- **Trigger:** a pending clarification occurs after 100 ordinary events in the retained global history. Reopening the questions screen or polling overview repeatedly requests the same first page.
- **Observed fresh SQLite probe:** first page returned `{count:0,cursor:"100"}`; requesting its continuation returned `{count:1,cursor:"102"}` with the current question. The screens never make that continuation request and display empty/no-attention copy.
- **Impact:** the operator cannot find or answer a current HQ question through the console after normal history growth. An empty filtered event page is not proof of no pending questions.
- **Required correction:** traverse the bounded cursor contract with cancellation and reconciliation of resolved questions, or expose a bounded current-question snapshot with explicit continuation. Surface incomplete/compacted coverage honestly. `operations-service.test.ts:579` tests continuation directly, but no screen regression covers it.

### R4 — P2: the approved dispatch injection path is absent

- **Location:** `apps/web/src/routes/operations-compose.tsx:75`, `apps/gateway/src/operations-controls.ts:59` and `:337`, `packages/orca-adapter/src/capabilities.ts:57` and `:159`.
- **Evidence:** the Task 4 plan explicitly requires dispatch exact IDs/incarnation/**inject**. The form has no injection choice or review field, the strict gateway/adapter inputs have no injection field, and generated dispatch argv never contains `--inject`. The public `orca orchestration dispatch --help` lists `--inject`; its public low-level topology guide uses `dispatch --task … --to … --inject` for delivery to a ready existing agent terminal.
- **Impact:** the delivered console implements only the non-injecting dispatch variant, without disclosing that limitation in the operator review. It does not meet the approved dispatch/inject acceptance requirement. This review did not execute either variant against real Orca.
- **Required correction:** implement the reviewed typed injection behavior with exact argv coverage and truthful unsupervised-dispatch semantics, or obtain an explicit scope change and visibly mark injection unsupported. Do not substitute raw argv or infer supervised resource ownership. `packages/orca-adapter/test/operations.test.ts:15` currently asserts the missing-flag behavior instead of testing the approved requirement.

### R5 — P2: the required combined operations smoke is not established by the durable tests

- **Location/evidence:** `apps/gateway/test/managed-service.test.ts:97` establishes real Unix claim → real loopback HTTP redemption → real SQLite journal for an HQ request, but `:109` injects a submit spy and `:127` supplies an Orca port that always throws. Its only mutation route is HQ submission at `:181`.
- `apps/gateway/test/operations-service.test.ts:65` tests gates against an in-process fake operation port, without HTTP or the public process boundary. `operations-orca.test.ts:11` replaces the process runner. `packages/orca-adapter/test/operations.test.ts:109` does exercise a fake executable, separately. `apps/gateway/test/end-to-end.test.ts:509` is the earlier production gateway state machine, not the new operations stack.
- **Gap:** no reviewed durable test joins owner claim, cookie/Origin/CSRF, actual operations routing, journal, `OperationsOrca`, and a fake executable/captured argv for an Orca mutation. The Task 4 report's combined real-server/fake-port sentence therefore overstates what this evidence proves. The on-disk journal test closes/reopens connections after manually marking a row prepared; it proves recovery of prepared rows, not process termination during an effect.
- **Required correction:** add the planned isolated combined smoke, or supply its exact durable artifact and accurate scope. Include real service responses parsed by the browser contract, positive fake control and denied/unknown cases, captured argv, deduplication, and a held viewer lease. Use no real Orca mutations. Repeating broad suites would not close this gap.

## Boundary audit and positive evidence

| Area | Assessment and inspected evidence |
|---|---|
| HQ / Orca identity separation | Source-specific routes/tabs and native Run/Task/Dispatch shapes are retained; HQ links arise only from complete `worker.ready`/`worker.retained` receipt payloads (`operations-service.ts:80`). Resource terminal identity has the concrete R2 failure. |
| Typed public CLI / process safety | Strict typed operations build argv server-side; process appends exactly one `--json`, uses `spawn` with `shell:false`, drains stderr, bounds stdout, strips ambient Orca authority from env, and aborts/terminates on deadlines (`capabilities.ts:157`, `process.ts:135`). Four concurrent reads, 10-second reads / 75-second controls, and 2 MiB bounds are wired in `operations-orca.ts:28`. No private Orca storage/API or browser raw-argv route found. Injection is R4. |
| Trusted local owner and browser session | Owner UID/type/mode validation, directory 0700 and Unix socket 0600 precede acceptance (`managed-control.ts:26`, `:148`). Managed listener binds 127.0.0.1 (`managed-service.ts:375`). Protected operations/auth require peer and exact Host, exact mutation Origin, cookie, CSRF, key, JSON, and 16 KiB body cap (`operations-http.ts:94`). Single-use 60-second claims and 30-minute in-memory sessions recheck expiry after body consumption (`:138`, `:165`). |
| Claim secrecy | Claim is issued only on owner socket, sent in a fragment, immediately removed by frontend bootstrap (`api.ts:105`), and never printed by `hq console` success/error handling (`installer/src/cli.ts:154`). No claim-bearing journal/log write was found in these paths. Launcher validates loopback/fragment and calls `/usr/bin/open` with one URL argv, no shell (`installer/src/console.ts:20`, `:48`). |
| Durable intent / uncertainty | Journal inserts prepared intent before effect, serializes duplicates, checks action/target/digest collisions, persists metadata only, and recovers prepared as unknown (`operations-journal.ts:36`, `:91`). Post-effect timeout/malformed/runtime ambiguity remains unknown; known rejection is distinct (`operations-controls.ts:355`). HTTP 409/502 receipts reach the browser without becoming success (`api.ts:89`). Client lifetime flaw is R1. |
| Fresh control gates | Owner Run generation and coordinator PTY incarnation are proved from native Task provenance; sender and target are re-read before effect. Dispatch gates pending same-run Task and connected/writable local incarnation. Stop/follow-up require exact live/live worker; release requires settled outcome and exact owned/releasable resource; uncertain, transferred, missing, or mismatched fields reject. Native HQ answers use HQ submission (`operations-controls.ts:97`, `:164`, `:242`, `:303`). |
| Monitoring / occupancy | Operations monitoring uses inbox, never check/ack; no operations read calls viewer acquire/heartbeat/release. Existing held-lease heartbeat after context/event/status reads is asserted in `operations-service.test.ts:168`. HQ admission counts/source are used directly (`managed-runtime.ts:433`), unaffected by external fleet observations or connection loss. Capacity has no write route. |
| Assets / package layout | Startup indexes index.html plus referenced hashed JS/CSS, keeps bytes in memory, rejects symlinked files/root, traversal encodings, missing or partial build, and arbitrary assets (`operations-assets.ts:7`). Protected API/auth routing precedes static fallback (`managed-service.ts:321`); extensionless non-API GET/HEAD fallback is bounded. Gateway dist → `../../web/dist` resolves to the built web tree. Root prepare orders core → adapter → web → gateway → installer. |
| Completion layout / redaction | `redactPublicResultText` shares credential/control removal but preserves harmless result layout (`core/src/public-output.ts:26`, `:41`). `publicProgressText` still first applies `redactRelayText` and retains its 14,000-character bound (`progress-events.ts:4`). The recorded focused regression and `tests/e2e/context-progress.spec.ts:236` cover long Korean completion, compaction, and duplicate identity. No weakening of those redaction steps found. |

The asset/launcher package report already discloses that the first fixture prepare attempted launcher registration and the existing-command guard refused overwrite; final CI fixture skipped install. That account is retained without recasting it as “prepare never attempted install.” The package evidence is an allowlisted source-runtime layout proof, not a public distribution or fresh-machine installation proof. Packaging was not rerun.

## Eight-screen acceptance map

| Screen | Result |
|---|---|
| Overview | Live source-separated HQ/Orca summaries, real HQ-only capacity, unavailable tokens/cost, and honest unsupported native inbox pending state. Question coverage defect R3. |
| Work list | Separate sources, search/filter, native Run/Task inspection, cursor invalidation and pagination fences retained from Task 3. |
| Compose | Full HQ text review and exact-ID Orca dispatch form; accepted is not completed. Lifetime guard R1; injection requirement R4. |
| Questions | HQ router vs native reply paths are distinct; native inbox pending state explicitly unsupported. Later-page HQ questions missing (R3). |
| Detail (HQ / Orca variants) | HQ event timeline remains separate from Orca terminal/transcript output; projection liveness, PTY observation, resource ownership and outcome stay distinct. Exact-state guards are present, but inspection clears mutation uncertainty (R1). |
| Resources | Hierarchy and host scope intended; valid native terminal rows fail parsing (R2). |
| Settings | Actual limit/source/active/queued with capacity update disabled; token/cost/currency/ETA/percent uncollected. |
| Evidence | Public source and observation data; native pending support limitation explicit. HQ evidence inherits R3. |

The supplied desktop and mobile overview captures are legible, use the expected responsive layout, and show unavailable metrics honestly. The existing Playwright suite asserts no body overflow, console errors, or external requests for its fake API routes; it does not exercise real auth, unknown/conflict transitions, native terminal shape, or every lifecycle control. Static screenshots do not establish those behaviors.

## Deferred functions and disposition

Capacity mutation/live reload, token/cost instrumentation, terminal send/close, viewer close/lease controls, arbitrary retry, remote browser exposure, private Orca interfaces, and public package distribution remain unsupported. They are not reported as implemented. Native inbox observations likewise cannot establish authoritative pending state.

**Task 4 Spec BLOCK / Quality BLOCK; overall BLOCK.** Resolve R1–R4 and close or substantiate the R5 acceptance evidence gap, then perform a focused independent re-review. Existing broad green runs remain useful regression evidence but do not override these reproduced defects. This review changed only this report and the operations progress report, performed no installation/packaging/build/commit/push/restart/real control, and left the workspace root mode 0755.
