# HQ + Orca Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the simulated screen plan with a real local single-operator console for observing HQ/public Orca and issuing only supported, safely fenced controls.

**Architecture:** Keep React/Vite and the managed gateway. A loopback HTTP surface serves the SPA and typed endpoints; an owner-only Unix-socket claim establishes a short browser session. HQ uses existing progress/store reads without viewer leases; Orca uses typed public-CLI operations with server-built argv, bounded process execution, fresh-state gates, and durable idempotency.

**Tech Stack:** Node 22, TypeScript, Zod, React 19, Vite 7, existing HTTP/SQLite patterns, Vitest, Testing Library, Playwright, public Orca CLI 1.4.203.

## Global Constraints

- Listen only on `127.0.0.1`; reject non-loopback peers, unexpected Host, and mutations whose Origin is not the exact runtime origin.
- Browser input is typed fields only: never executable/path/raw argv/shell/connection environment/`nextAction.argv`; all child processes use `shell:false`.
- Issue a one-time 60-second claim only over owner-mode `control.sock`; redeem once into a 30-minute in-memory session with `HttpOnly; SameSite=Strict; Path=/` cookie.
- Mutations require cookie, exact Origin, session CSRF, and `Idempotency-Key`. Same key+digest replays; different action/target rejects.
- Orca reads: 10-second timeout, 2 MiB stdout, list cap 100, log cap 500. Controls: 75 seconds, 2 MiB. Timeout/overflow/invalid JSON/connection loss/source change/release unknown never become success.
- Monitoring may call `orchestration inbox`, never `check` or acknowledgement. Reply occurs only on explicit operator action.
- Keep HQ request/context/event and Orca Run/Task/Dispatch as separate source-tagged records/tabs. Link only from exact IDs in HQ `worker.ready|worker.retained` receipts; otherwise show “아직 없음.”
- HQ browser reads never acquire/heartbeat/release a viewer lease, so an existing `hq watch` holder remains unaffected.
- `unknown|unverifiable|release_pending|release_unknown|transferred`, absent liveness, and disconnect stay occupied/uncertain and permit inspect/wait only—not stop/retry/dispatch/release or capacity decrement.
- `202`/CLI accepted means accepted, not completed; terminal success requires a later authoritative observation.
- Capacity is HQ admission only; default 10 applies only with no config/env value. External Orca fleet counts are excluded.
- Capacity update is unsupported here: source has startup-only resolution and no safe live reload/mutation. Expose `updateSupported:false`, reason `restart_safe_mutation_contract_unavailable`; create no write route.
- Tokens/cost/currency/ETA/percent are unavailable; render “수집되지 않음,” never zero/estimate.
- Reuse dependencies/patterns; no framework migration, private Orca API/storage, new worktree, package install, or production mutation during validation.

## Shared Contract

Task 1 creates strict Zod schemas/types in `packages/core/src/operations.ts`:

- `Evidence={source:"hq_api"|"hq_store"|"orca_cli",command?,observedAt,verification:"authoritative"|"observed"|"unverifiable"}`.
- `Support={supported:true}|{supported:false,reason}`.
- `OperationsStatus={collectedAt,hq:{state,capacity:{limit:number|"unlimited",source:"config"|"environment"|"default",active,queued,byState,updateSupported:false,reason}},orca:{state,reachable,connectionState?,version,runtimeId?,features},metrics:{tokens:{available:false,reason:"not_collected"},cost:{available:false,reason:"not_collected"}}}`.
- `HqContextPage/HqEventPage` preserve current core snapshot/event/compaction fields; links are optional receipt-derived `{runId,taskId,dispatchId,terminalHandle}` only.
- `HqQuestion={source:"hq",kind:"router_clarification"|"managed_orca_question",requestId,sessionId,contextId?,messageId?,body,occurredAt,state,evidence}`.
- `OrcaRunPage/OrcaTaskPage/OrcaWorkerPage` preserve documented IDs/status/paging/scope. `OrcaWorkerDetail` keeps `projection.liveness.verdict`, `observation.status`, `exactWorker`, terminal connected/writable/incarnation, outcome, and resource settlement separate.
- `OrcaOutputPage` is transcript messages or terminal lines plus source/cursor/archived/warnings; sanitize all human-controlled strings.
- `OrcaQuestion={source:"orca",messageId,runId?,taskId?,dispatchId?,terminalHandle?,body,occurredAt?,state:"pending",evidence}`.
- `OrcaResourceInventory` is project → host setup → worktree → terminal with exact public fields and host covered/not-covered scope.
- `OperationsMutationReceipt={requestId,action,targetId,state:"accepted"|"rejected"|"unknown",observedAt,detail?}`; detail is bounded public status/verdict only.

Typed routes:

| Route | Exact behavior |
|---|---|
| `POST /auth/local/claim`, `POST /auth/local/refresh` | One-time capability claim / same-session CSRF refresh. |
| `GET /api/operations/status` | HQ health/capacity and Orca runtime/capability matrix; cost/tokens unavailable. |
| `GET /api/operations/hq/contexts[?sessionId]`, `/contexts/:id`, `/requests/:id` | Existing snapshots only; no inferred identity. |
| `GET /api/operations/hq/events?contextId&after&limit` | Bounded page/compaction; no follow stream or lease operation. |
| `GET /api/operations/hq/questions` | Stored clarification events plus current request state. |
| `POST /api/operations/hq/requests` | Existing `{requestId,sessionId,text,contextHint?}`; new/continue/clarification, 8,000-char route bound. |
| `GET /api/operations/orca/runs`, `/runs/:id`, `/tasks?runId`, `/workers?runId&cursor`, `/workers/:id` | Typed run/task/worker public CLI reads; remote scope warnings preserved. |
| `GET /api/operations/orca/workers/:id/output?source&cursor&limit` | Bounded `worker-read`; `source_changed` is conflict, not empty. |
| `GET /api/operations/orca/questions` | `inbox --limit 100`, questions only, no consumption/ack. |
| `GET /api/operations/orca/resources` | Bounded project setups/worktree/terminal inventory. |
| `POST /api/operations/orca/dispatches` | Re-read task+terminal; require run ownership and same connected/writable incarnation, then typed `dispatch`. |
| `POST /api/operations/orca/followups` | Re-read exact live worker, then typed `send --to dispatch:<id> --type status`; accepted is not processed. |
| `POST /api/operations/orca/replies` | Require ID in fresh question inbox, then typed `reply`; accepted is not completion. |
| `POST /api/operations/orca/workers/:id/stop` | Require exact worker and both projection/PTY liveness `live`. |
| `POST /api/operations/orca/workers/:id/retain` | Require exact owned/retained resource and supported capability. |
| `POST /api/operations/orca/workers/:id/release` | Require authoritative settled outcome and releasable exact resource. |

No capacity mutation, terminal send/close, viewer close/lease, arbitrary retry, or raw CLI route.

SQLite audit/idempotency table: `operations_mutation_receipts(request_id PRIMARY KEY,action,target_id,input_digest,state,detail,observed_at)`. Store no body/transcript/cookie/CSRF/secret. Persist unknown and return it unchanged on replay.

## Task 1: Shared contract, sanitization, typed public CLI adapter

**Owner:** Contract/adapter only. **Suggested model:** `gpt-5.6-luna`, medium.

**Files:** Create `packages/core/src/operations.ts`, `packages/core/src/public-output.ts`, `packages/core/test/operations.test.ts`, `packages/core/test/public-output.test.ts`, `packages/orca-adapter/test/operations.test.ts`, `packages/orca-adapter/test/process.test.ts`; modify `packages/core/src/index.ts`, `packages/installer/src/progress-client.ts`, `apps/gateway/src/progress-events.ts`, `packages/orca-adapter/src/{capabilities,process,index,receipts}.ts`.

**Interfaces:** Produce Shared Contract schemas/types; `sanitizeDisplayText`, `sanitizeResultText`, `redactPublicText`; typed operations for `status`, orchestration run/task/worker/inbox/dispatch/send/reply/stop/retain/release, project list/setups, worktree list/show, terminal list/show/read. Adapter alone appends `--json`; every mutation requires `retryRequestId`, mapped to the public CLI's `--retry-request`. Project inventory uses `project list`, then `project setups --project`; worktree enumeration uses each setup's exact `repoId` with `worktree list --repo id:<repoId>`. The public `task-list` command has no limit flag, so the adapter requests `--brief` and rejects receipts over the 100-row contract cap.

- [x] Write failing schema/sanitizer tests: reject HQ records containing Orca IDs outside optional receipt links; redact credentials/control sequences; fix unavailable metrics; validate ID/text/limit enums.
- [x] Write failing argv tests for every command prefix/flag and process tests for `shell:false`, bounded env, exactly one `--json`, timeout, 2 MiB overflow, invalid/nonzero receipt.
- [x] Implement shared schemas/sanitizers; installer re-exports existing sanitizer names and gateway uses shared redaction without changing current display/result bounds.
- [x] Extend adapter variants/receipt envelope and optional `maxOutputBytes` default 2 MiB; preserve existing operations.
- [x] Validate: `pnpm vitest run packages/core/test/operations.test.ts packages/core/test/public-output.test.ts packages/orca-adapter/test/operations.test.ts packages/orca-adapter/test/process.test.ts packages/installer/test/progress-client.test.ts`; then core/orca-adapter/installer typechecks.
- [ ] Commit only listed files: `feat: add operations console contracts`.

## Task 2: Trusted loopback bridge and safe projections/controls

**Owner:** Gateway only. **Suggested model:** `gpt-5.6-sol`, high.

**Files:** Create `apps/gateway/src/operations-journal.ts`, `apps/gateway/src/operations-service.ts`, `apps/gateway/src/operations-http.ts`, `apps/gateway/test/operations-journal.test.ts`, `apps/gateway/test/operations-service.test.ts`, `apps/gateway/test/operations-http.test.ts`; modify `apps/gateway/src/managed-control.ts`, `apps/gateway/src/managed-service.ts`, `apps/gateway/src/managed-runtime.ts`, `apps/gateway/test/managed-control.test.ts`, `apps/gateway/test/managed-service.test.ts`, `apps/gateway/test/managed-runtime.test.ts`.

**Interfaces:** Consume Task 1, `ProgressStore`, progress HTTP port, admission snapshot/attempts, resolved capacity/source. Produce `OperationsService` method per route and `OperationsHttp.issueClaim():{url,expiresAt}`. `startManagedControl` gains only typed `POST /v1/operations/session`; no generic handler.

- [ ] Write journal tests: same key/digest calls effect once; collision rejects; prepared/timeout becomes durable unknown; persisted rows contain metadata only.
- [ ] Implement serialized SQLite journal in existing managed-control DB, inserting intent before effect and storing bounded public result.
- [ ] Write projection tests: HQ/Orca separation, receipt-only links, compaction cursor, secret redaction, host scope warnings, HQ-only occupancy, config/env/default source, unavailable metrics.
- [ ] Prove lease coexistence: hold a viewer lease, perform context/event/status reads, then heartbeat the original holder successfully; assert no acquire/release calls.
- [ ] Table-test gates: stop/follow-up only exact live/live; dispatch same run task and terminal incarnation; reply fresh question; release settled/releasable; uncertain/changed/missing fields reject without CLI mutation.
- [ ] Implement typed CLI fan-out (max four concurrent reads), paging, error normalization, and capabilities. Monitoring uses inbox only, never check/ack.
- [ ] Route HQ-managed native answers through HQ `/answer <messageId> <body>` submission; direct Orca reply only for external questions.
- [ ] Write auth/HTTP tests: peer/Host/Origin rejection, single-use expiry, cookie+CSRF, 16 KiB body cap, session expiry, security headers, protected-route fail-closed.
- [ ] Wire existing progress store/runtime/admission and typed Orca client in managed runtime; keep `/health` shape unchanged.
- [ ] Validate: focused new tests plus `managed-control`, `managed-service`, `managed-runtime`, `progress-control`; then gateway typecheck.
- [ ] Commit only listed files: `feat: add trusted local operations bridge`.

## Task 3: Real read-first React console

**Owner:** Frontend reads only. **Suggested model:** `gpt-5.6-terra`, high.

**Files:** Modify `apps/web/package.json`, `apps/web/src/api.ts`, `apps/web/src/api.test.ts`, `apps/web/src/app.tsx`, `apps/web/src/app.test.tsx`, `apps/web/src/styles.css`, `apps/web/vite.config.ts`; create `apps/web/src/components/source-badge.tsx`, `apps/web/src/components/async-state.tsx`, `apps/web/src/routes/operations-overview.tsx`, `operations-list.tsx`, `operations-detail.tsx`, `operations-resources.tsx`, `operations-settings.tsx`, `operations-evidence.tsx`; delete `apps/web/src/routes/command-list.tsx`, `command-detail.tsx`.

**Interfaces:** Consume Shared Contract/Task 2. Produce routes `/overview`, `/work`, `/work/hq/:contextId`, `/work/orca/:dispatchId`, `/compose`, `/questions`, `/resources`, `/settings`, `/evidence`. Fetch uses same-origin credentials and schema validation; queries may recover session once, mutations never auto-retry.

- [ ] Replace API tests: claim/refresh, malformed response rejection, opaque cursors, stale read abort, `202` remains queued, no ambiguous mutation replay.
- [ ] Implement API client and remove claim fragment immediately after redemption.
- [ ] Write screen tests: separate source columns/tabs, receipt-only link, separate liveness/PTY, collapsed paged log, resource hierarchy/scope, unavailable metrics, disabled capacity update, distinct loading/empty/disconnected/error/unknown states.
- [ ] Port approved visual system/responsiveness; remove simulation strip/scenario/fixtures/synthetic state. Poll visible overview/lists every 5s and HQ event cursor every 2s; abort on navigation/hidden page.
- [ ] Ensure eight screens map exactly: overview, list, compose placeholder, questions placeholder, detail, resources, settings, evidence; never merge HQ events with Orca output.
- [ ] Add the missing `typecheck` package script, then validate `pnpm --filter @orca-hq/web test`, `build`, and `typecheck`; assert bundle has no CDN/remote assets.
- [ ] Commit only listed files: `feat: build live operations monitoring views`.

## Task 4: Controls, secure launcher, assets, end-to-end acceptance

**Owner:** Sequential integration. **Suggested model:** `gpt-5.6-sol`, high.

**Files:** Create `apps/web/src/routes/operations-compose.tsx`, `apps/web/src/routes/operations-questions.tsx`, `apps/web/e2e/operations-console.spec.ts`, `apps/gateway/src/operations-assets.ts`, `apps/gateway/test/operations-assets.test.ts`, `packages/installer/src/console.ts`, `packages/installer/test/console.test.ts`; modify `apps/web/src/routes/operations-detail.tsx`, `operations-settings.tsx`, `apps/web/src/app.tsx`, `app.test.tsx`, `api.ts`, `api.test.ts`, `apps/gateway/src/operations-http.ts`, `managed-service.ts`, `packages/installer/src/cli.ts`, `packages/installer/test/cli.test.ts`, `documented-commands.test.ts`, `package.json`; delete `apps/web/e2e/mobile-dashboard.spec.ts`.

**Interfaces:** Produce `launchConsole()` which requests the claim through `control.sock` then calls `/usr/bin/open` with one URL argv; `createOperationsAssets(root)` serves only indexed `index.html` and hashed Vite JS/CSS, never source/arbitrary paths.

- [ ] Test UI state machines: HQ new/continue/clarification 8,000-char review; stable request ID; dispatch exact IDs/incarnation/inject; external reply/follow-up accepted-not-processed; stop live/live; release settled; retain separate; unsafe click guards; capacity disabled.
- [ ] Implement forms/modals. On unsafe conflict refresh detail; on unknown show inspect-only and never generate an automatic retry/new ID.
- [ ] Test assets against traversal/symlink/missing-build; test launcher uses `/usr/bin/open`, argv array, no shell, and fragment claim URL.
- [ ] Serve protected routes before fixed assets; SPA fallback only for extensionless non-API paths. Add `hq console` and build core/adapter/web/gateway/installer in root `prepare`; add no dependency.
- [ ] Playwright with typed fake API: all eight routes, tabs/search/filter/log paging/modal Escape/focus, accepted copy, unsafe controls, 1440/1280/390 no body overflow, no console/external-network errors.
- [ ] Real-process fake-port smoke: Unix claim→HTTP redeem→reads→fake mutations, captured typed argv, journal, auth fences, bounds, lease non-interference. Never invoke real Orca mutations.
- [ ] Validate: installer/gateway/web tests, web build/E2E, then `pnpm typecheck && pnpm build && pnpm test`.
- [ ] Commit only listed files: `feat: ship local HQ operations console`.

## Task 5: Independent integration review

**Owner:** Fresh read-only reviewer. **Suggested model:** `gpt-6-astra`, high.

**Files:** Read only Tasks 1–4 changes plus approved research/README; create `docs/superpowers/reports/2026-09-15-hq-orca-operations-integration-review.md`.

- [ ] Audit identity separation, typed argv/no shell/private API, bounds/redaction, loopback/Host/Origin/session/CSRF, idempotency/unknown, and absence of monitoring check/ack.
- [ ] Map all eight screens and approved semantics: accepted≠complete; liveness≠PTY; uncertainty occupies/disables; capacity HQ-only/read-only; viewer lease untouched; cost/tokens unavailable.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm --filter @orca-hq/web test:e2e`.
- [ ] Report `Verdict: PASS|BLOCK`, exact evidence/findings, and deferred items: capacity mutation, cost/token instrumentation, terminal send/close, viewer close, arbitrary retry, remote browser exposure.

## Order and Ready Task

Run Tasks 1 → 2 → 3 → 4 sequentially, each only after its focused validation passes; then assign Task 5 to a fresh reviewer. Delegated implementation is already selected, so Task 1 is ready to dispatch now without another approval question.
