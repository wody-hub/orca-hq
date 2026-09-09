# HQ progress implementation coordination

User authorized implementation with real Orca orchestration and role/model selection. Native Run: `run_13fc633f1cf3`. Coordinator: `term_ddbae81e-19f0-4144-b85e-3c6c8ef92cc5`. Working directory for every worker: `/Users/j.jaeyo/Project/ETC/orca-hq` (existing uncommitted work must remain).

Native worker-start receipts confirmed `ready/input_accepted` for all three workers:

2026-09-08 11:56: Claude CLI worker reached its individual spend limit (provider reported reset at 14:30). Native worker-stop settled the original Dispatch failed/process_exited; readback confirmed the exact terminal is disconnected and not writable. worker-release returned identity_unproven/retained and made no process action. CLI work is being continued with a new Codex GPT-6 Astra high Dispatch, preserving the existing files. The original task remains the CLI ownership contract below.

## CLI continuation checkpoint

Existing `packages/installer/src/progress-client.ts` and `watch.ts` plus matching tests are implemented; previous worker reported 20 + 14 tests green. Seqless `history.compacted` support and viewer heartbeat 5s were added after review. Still finish `progress-window.ts`, asynchronous `chat.ts`, `hq watch`/chat flag wiring in `cli.ts`, exports/build, and meaningful tests. Do not restart design or rewrite passing modules wholesale. Read the current tests and team wire contract. Original CLI worker was `ctx_4719aa6920ed`; it cannot finish because of provider spend limit.

Important remaining/review contracts: Ctrl+C in watch must abort heartbeat sleep promptly; snapshot failure must release an acquired lease; refresh authoritative context state so HQ response completion does not imply native work finished. Auto windows open only for live assignments belonging to newly submitted requests, never historical replay or background job events; a new explicit followup may reopen a closed viewer. Same context reuses live viewer; different context gets a new Terminal window. `/new` switches input session without stopping existing work/viewers. `history.compacted` is seqless `{kind,occurredAt,oldestSeq,latestSeq,snapshots}` and advances cursor to latestSeq. Runtime currently emits contextId-null aggregate final events plus per-context final detail; chat displays aggregate once and watch context detail. Check coordinator mailbox regularly because `orchestration send` is inbox mail, not prompt injection.

Coordinator owns `packages/installer/src/control.ts` narrow installed parity change: legacy timeout is 240 seconds, matching installed app. Do not alter it. New progress client timeout is independent. Coordinator root integration tests are `tests/e2e/context-progress.spec.ts` and `tests/chaos/context-progress-restart.spec.ts`; do not edit them. All implementation approval already exists; do not ask user for design confirmation.

| Owner | Task | Dispatch | Effective launch |
| --- | --- | --- | --- |
| Storage | `task_9381574fb579` | `ctx_cdf66ca339a8` | Codex `gpt-5.6-sol`, high |
| Runtime | `task_6e124feae41a` | `ctx_a393804108fe` | Codex `gpt-6-astra`, high |
| CLI | `task_f0766f0d3de7` | `ctx_4719aa6920ed` | Claude `opus` alias, high |

Model rationale: Astra handles cross-component concurrency and migration; Sol handles transactional persistence; Claude provides a separate implementation perspective on terminal UX and OS integration. OpenAI model guidance checked at https://developers.openai.com/api/docs/models. Claude alias support verified through the installed CLI and Orca launch receipt; no unverified claim about its underlying version.

## Owners

- Storage worker (Codex GPT-5.6 Sol high): `packages/core/src/progress.ts`, its exports/build wiring; `apps/gateway/src/progress-store.ts`, `execution-reservations.ts`, matching tests. Publish the exported store interfaces early and notify coordinator. Do not edit runtime integration or installer files.
- Runtime worker (Codex GPT-6 Astra high): gateway source/tests EXCEPT storage-owned files; installed-source parity, async progress HTTP, context routing/execution with FIVE contexts, native job tracking, production wiring. Read installed files only; never deploy. Coordinate storage interface via this file or messages.
- CLI worker (Claude Opus high): `packages/installer/src/{progress-client,watch,progress-window,chat,cli}.ts`, installer tests and needed installer export/build metadata. Do not edit gateway or core contracts. Wire contract below is authoritative until coordinator approves changes.
- Main coordinator: integration review, E2E tests, docs and installed validation. Changes to somebody else's files only after coordinating.

Every worker is sharing the workspace: do not revert others' edits, do not commit/push, do not spawn subworkers, do not alter the installed application or send Slack/Telegram messages. Protect `docs/superpowers/plans/2026-09-01-orca-hq-private-pilot-roadmap.md`: do not read/hash/diff/stage/restore/edit it, and avoid broad commands that would include it. Read the specific context progress spec/plan, not all docs. Report native worker_done exactly once under the injected Orca lifecycle. Unit/integration tests first for meaningful behavior.

## Wire contract for server and CLI

Use existing owner-only control socket, preserving `POST /commands` and legacy CLI behavior.

- `POST /v1/progress/requests` body `{requestId, sessionId, text, contextHint?: {mode:'new'|'continue',contextId?:string}}`; 202 `{requestId,state:'queued'}`. Same ID + same content is idempotent. Resume discovery is GET, never automatic new-ID replay.
- `GET /v1/progress/requests/:id` returns `{requestId,sessionId,state,contextIds:string[],result?:{text,jobId?}}`.
- `GET /v1/progress/events?sessionId=ID&after=N&follow=1` OR `?contextId=ID&after=N&follow=1` is NDJSON: persisted event `{seq,eventKey,requestId,contextId:string|null,kind,source,occurredAt,payload:Record<string,unknown>}`; ephemeral heartbeat `{kind:'heartbeat',occurredAt}` without seq. Only persist/update cursor on valid event seq. Payload display text is `payload.text`; context.assigned also has `payload.title`, `payload.relation:'new'|'continue'`, `payload.contextId`. request.completed payload includes `text`. Failure payload includes `text`. Snapshot is authoritative after compaction.
- `GET /v1/progress/contexts` returns `{contexts:[ContextSnapshot]}` (optional sessionId filter).
- `GET /v1/progress/contexts/:id` returns ContextSnapshot `{contextId,title,state,summary,projectIds:string[],jobIds:string[],createdAt,updatedAt,lastSeq:number}`. Fields may be augmented, not renamed.
- `POST /v1/progress/contexts/:id/viewer-lease` body `{viewerInstanceId}` returns `{acquired:boolean,viewerInstanceId,leaseToken?:string,expiresAt:string}`. Server issues token only on successful acquisition. CLI opening window reserves lease and passes opaque instance/token to watch as flags; direct `hq watch` reserves on its own.
- `POST /v1/progress/contexts/:id/viewer-heartbeat` and `DELETE /v1/progress/contexts/:id/viewer-lease` body `{viewerInstanceId,leaseToken}`; 200 `{ok:true}` or conflict on stale token.
- 404 missing item; 409 request collision/lease mismatch; 400 malformed input. Error JSON `{text:string}`. Local control boundary validates fixed local owner; never accepts arbitrary owner keys from HTTP.
- retention `history.compacted` control frame includes snapshot/current oldest sequence. Both sides must agree concrete recovery fields before implementing this edge.

CLI commands: `hq chat [--session ID] [--progress-window=auto|off]`; `hq watch --context ID [--viewer-instance ID --lease-token TOKEN]`. Original input stays usable after durable acceptance. Auto new macOS Terminal window per context; reuse live viewer; no new GUI windows on Slack/Telegram, SSH or pipe. Closing watch never stops work. Viewer should remain after completion for followups.

## Integration priorities

This is a complete implementation, not a mock UI. Maintain FIVE independent context executions (sixth FIFO waits), same-context serialization, real scoped Codex threads and native worker resource ownership; HQ receipt/classification/status/control must stay responsive. Existing installed agent conversation files are absent from repo and need careful parity integration by runtime owner. Semantic context routing must not be reduced to a hardcoded project-name regexp. Native resource uncertainty retains reservations and never duplicates an editor.

Persist requests before execution, durable events/cursors, stable request/effect identity, viewer leases and resource reservations. Do not hold the HTTP response open until the model finishes. Progress observes actual public commentary/tool calls/native states, not invented reasoning or steps. Default read-only viewer must not be a second execution agent.

The design is approved; do not stop for repeated design approvals. Send concrete contract questions through native orchestration. Keep updates concise with actual file/type names so other workers can integrate while you continue.
