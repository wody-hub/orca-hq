# Task 3 — Real read-first React operations console

Date: 2026-09-15 KST
Status: implemented and focused verification passed; Task 4 controls/E2E pending

## Delivered routes

- `/overview`: real status, HQ capacity, source-separated context/Dispatch summaries, connection state, questions, uncertainty attention list, and unavailable metrics.
- `/work`: HQ contexts and Orca Runs/Dispatches remain separate, with source filters, deduplication, and guarded cursor pagination.
- `/work/hq/:contextId`: HQ context/evidence plus a bounded 2-second incremental event stream; compaction is explicit and only valid receipt links navigate to Orca.
- `/work/orca/:dispatchId`: native Dispatch/worker projection, liveness, observation, PTY, incarnation, ownership, and release state; terminal/transcript logs are separate tabs and load only on demand.
- `/resources`: bounded project → setup → worktree → terminal hierarchy with covered/not-covered and truncation evidence.
- `/settings`: real capacity source/counts, disabled unsupported capacity update and reason, and tokens/cost/currency/ETA/percent as “수집되지 않음.”
- `/evidence`: source/verification/timestamp evidence from HQ store and public Orca CLI reads, including explicit unsupported authoritative pending-question state.
- `/compose` and `/questions`: compose remains an honest Task 4 placeholder; questions are real read-only HQ/Orca lists with reply controls explicitly disabled until Task 4.

## API and session contract

- `createOperationsApi` exposes typed status, contexts/events/questions, Runs/workers/detail/output, resources, and mutation receipt methods against the final Task 2 routes.
- Dependency-free runtime schema parsers validate required fields, discriminants, bounds, native snake_case Run fields, nested worker/PTY/resource identities, source tags, evidence, cursors, and terminal-vs-transcript output before values reach React. They intentionally preserve verified extra native fields without `any` or response casts.
- A `#claim=` fragment is removed before validation/network settlement, then a valid 43-character claim is redeemed exactly once. CSRF is retained only in `sessionStorage`; refresh requires that existing token, rotates it, and only a read may retry once.
- No unauthenticated bootstrap is invented. Missing/expired auth gives actionable `hq console` guidance; mutations neither auto-retry nor mint IDs, and accepted receipts remain accepted rather than completed.
- Same-origin credentials are used throughout. AbortSignals cancel reads on route unmount/hidden page; completion-scheduled 5-second overview/list polling and 2-second HQ event polling prevent overlap.
- HQ event cursors advance monotonically and deduplicate by sequence. Opaque Orca cursors are encoded unchanged; repeated terminal/transcript pages are suppressed and logs are bounded to 500 entries.

## Visual and interaction result

- Ported the approved warm-gray surfaces, navy sidebar, blue HQ/emerald Orca badges, attention list, compact cards/tables, responsive typography, mobile navigation, keyboard focus, and reduced-motion handling.
- Removed the simulation strip, scenario selector, fixture-driven production state, legacy command/approval routes, and synthetic responses.
- Loading, empty, disconnected/auth, malformed/error, and unverifiable/unknown states use distinct copy and styling.

## Focused verification

- `pnpm --filter @orca-hq/web test`: **19 tests passed / 2 files**.
- Coverage includes claim/refresh/fragment removal, coalesced concurrent recovery, malformed payload rejection, opaque cursors, abort propagation, accepted/unknown mutation non-replay, source filters, detail tabs/on-demand logs, receipt links, compaction, pagination, stale navigation abort, resources, unavailable metrics, disabled capacity, auth guidance, and Task 4 placeholders.
- `pnpm --filter @orca-hq/web typecheck`: passed.
- `pnpm --filter @orca-hq/web build`: passed; Vite transformed 39 modules and produced local HTML/CSS/JS assets.
- Built output check found no remote `src`, `href`, or CSS `url()` asset references.

## Changed paths

- Updated: `apps/web/package.json`, `src/api.ts`, `src/api.test.ts`, `src/app.tsx`, `src/app.test.tsx`, `src/styles.css`.
- Added: `src/hooks.ts`, `src/components/{async-state,source-badge}.tsx`, and six `src/routes/operations-*.tsx` modules.
- Deleted: legacy `src/routes/{command-list,command-detail}.tsx` and `src/components/approval-card.tsx`.
- Reports: this report, `2026-09-15-hq-orca-operations-task3.diff`, and the progress entry.

## Known limits / handoff

- Task 4 owns mutation forms, question replies, lifecycle controls, launcher/static serving, and full browser E2E. This task performs no simulated or real mutation.
- No backend/installer/protected-plan edit, install, commit, push, restart, or production operation was performed.
