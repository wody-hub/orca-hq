# Task 4 — controls, secure launcher, assets, and end-to-end acceptance

Date: 2026-09-15 KST  
Implementation: **PASS**  
Independent integration review: **pending (Task 5)**

## Entry gate

- Independently reviewed only Task 3 fix round 2 Q4 against the prior finding, its fix report/overlay, and the two changed frontend files.
- Verdict: **Spec PASS / Quality PASS**. The refreshed first-page owner advances the generation, aborts obsolete pagination, restores readiness, and fences late stale settlement. The review reused the recorded 31 web tests / 2 files and web typecheck; it did not rerun broad validation.
- Durable review: `docs/superpowers/reports/2026-09-15-hq-orca-operations-task3-fix2-review.md`.

## Delivered behavior

### Operator console

- Added reviewed HQ new/continue/clarification forms with the route's 8,000-character limit, stable `request_<uuid>` idempotency IDs, a final review modal, Escape handling, initial focus, and focus restoration.
- Added HQ clarification replies and native Orca question replies, exact-ID dispatch, worker follow-up, stop, retain, and release. Browser guards require the displayed exact task/run/terminal/Dispatch/incarnation, projection and PTY liveness where applicable, authoritative settlement, and owned/releasable resources; a server conflict refreshes authoritative detail.
- `accepted` is explicitly presented as receipt-only, not completion. `unknown` becomes inspect-only, retains the same request identity, and offers no automatic retry or fresh-ID control.
- Added work-list search while preserving source tabs, filters, paged logs, read-only startup capacity, unavailable metrics, and the rule that the native inbox has no authoritative HQ-owned pending state.

### Gateway and launcher

- Added `createOperationsAssets(root)`: startup indexes only `index.html` plus its referenced hashed Vite JavaScript/CSS. It rejects traversal encodings, symlinked roots/members, arbitrary files, unsafe asset names, missing index/assets, and partial builds. API/auth routes and `/health` remain ahead of SPA fallback; only extensionless non-API GET/HEAD routes receive the SPA.
- Added `launchConsole()`: it claims a one-time URL through the owner `control.sock`, validates an exact loopback fragment URL, then invokes `/usr/bin/open` with one argv, `shell:false`, bounded output, and a deadline. The CLI does not print the claim.
- Root `prepare` now orders core → Orca adapter → web → gateway → installer before the guarded global launcher registration. No dependency was added.
- Mutation HTTP error handling now preserves journaled `rejected`/`unknown` receipts returned with 409/502. The frontend response parser now applies array element parsers without leaking `Array.map` indexes as optional length arguments.
- Added an on-disk SQLite close/reopen regression for interrupted mutation intent; restart reloads it as `unknown` rather than rerunning the effect.

### Root-suite regression repaired

- The first root run reported 1,324 passing tests and one deterministic failure in `tests/e2e/context-progress.spec.ts`: a long Korean completion lost harmless trailing whitespace before compaction.
- Root cause was Task 1's use of the normalized public display redactor for durable completion results. Added `redactPublicResultText`, sharing the same control/credential redaction and bounding while preserving safe result layout, and routed `publicProgressText` through it.
- Focused unit and real-socket completion/compaction/idempotency tests passed before the single root-suite rerun. Credential, bearer token, private-key, GitHub token, AWS key, and control-sequence coverage remains green.

## Validation evidence

- `pnpm --filter @orca-hq/web test`: **37 passed / 2 files**.
- `pnpm vitest run apps/gateway/test/operations-assets.test.ts apps/gateway/test/operations-http.test.ts apps/gateway/test/operations-journal.test.ts apps/gateway/test/operations-orca.test.ts apps/gateway/test/operations-service.test.ts apps/gateway/test/end-to-end.test.ts`: **62 passed / 6 files**.
- `pnpm vitest run packages/installer/test/console.test.ts packages/installer/test/cli.test.ts packages/installer/test/documented-commands.test.ts`: **61 passed / 3 files**.
- Web, gateway, and installer package typechecks passed during focused work.
- `pnpm --filter @orca-hq/web test:e2e`: **4 passed**. The typed fake API covers all eight routes, source tabs, work search/filter, log paging, keyboard review/focus restoration, accepted copy, disabled capacity, and 1440/1280/390 layouts with no body overflow, console error, or external request.
- Focused root-regression verification: `pnpm vitest run apps/gateway/test/progress-events.test.ts packages/core/test/public-output.test.ts tests/e2e/context-progress.spec.ts -t "preserves safe completion result layout|public output sanitizers|keeps a long Korean result and duplicate-request identity after completed detail is compacted" --reporter=dot`: **5 passed / 3 files**.
- Final `pnpm test`: **1,326 passed / 104 files**.
- Final `pnpm typecheck && pnpm build`: passed. Vite transformed 41 modules and emitted `apps/web/dist/index.html`, hashed `index-DFMuge9p.css`, and hashed `index-DywivQX8.js`; all 15 buildable workspace projects completed.
- Isolated real-server/fake-port coverage exercised owner Unix claim → HTTP redemption → authenticated reads/mutations → SQLite journal replay, Origin/CSRF/idempotency/identity fences, captured typed Orca argv, and HQ reads without viewer-lease acquisition. No real Orca control was invoked.
- Post-run checks found no listener on Playwright port 4173 and no matching Vite preview process. Both owned package-fixture directories were removed, while the workspace root remained mode 0755.

## Screenshots

- `screenshots/2026-09-15-operations-1440.png` — 1440×900.
- `screenshots/2026-09-15-operations-1280.png` — 1280×800.
- `screenshots/2026-09-15-operations-390.png` — 390×1465 full-page mobile capture.

## Package/runtime asset proof

- The repository remains an invitation-only source install, not a published npm/Homebrew package. A temp allowlisted fixture contained only the root manifest and built gateway/web/installer runtime trees; it did not contain project docs or protected planning material.
- The first no-version probe failed before packing with `Invalid package, must have name and version`. After adding a fixture-only version, the first pack printed the root `prepare` command; `install-global.js` reached its existing-command conflict guard and explicitly refused to overwrite `/Users/j.jaeyo/.local/bin/hq`, so no launcher installation occurred.
- The final fixture reran with `CI=true`. npm still printed the package `prepare` command, but `install-global.js`'s top-level CI guard skipped `installGlobalCommand`; all work occurred under `/tmp`, and no production install ran. The resulting 310-entry tarball contained `apps/web/dist/index.html`, both indexed hashed JS/CSS files, `apps/gateway/dist/operations-assets.js`, `packages/installer/dist/console.js`, and `packages/installer/bin/hq.js`.
- This proves the source-runtime relative layout consumed by gateway (`apps/gateway/dist` → `apps/web/dist`) is present in the isolated artifact. It is not a claim that a public package distribution now exists.

## Developer usage

```bash
pnpm build
pnpm hq console
```

An installed source checkout may use `hq console`. The owner-socket claim expires after 60 seconds and is exchanged for the local browser session; do not copy or log the fragment. Treat `accepted` as pending observation and `unknown`/`unverifiable` as inspect-only.

For development-only browser acceptance, use:

```bash
pnpm --filter @orca-hq/web test:e2e
```

The Playwright suite builds and previews on loopback with typed fake API routes; it does not contact a production gateway or Orca.

## Limits and handoff

- Capacity remains startup-only with default 10 and no write route. Tokens, cost, ETA, percent, and currency remain unavailable rather than fabricated.
- The console is loopback, single-owner, and cookie/Origin/CSRF protected. Remote browser exposure, terminal send/close, arbitrary retry, viewer-lease control, and private Orca interfaces remain out of scope.
- Browser E2E uses deterministic fake API data; the lower-level smoke uses a real isolated HTTP/Unix/SQLite stack with fake Orca/ports. Neither substitutes for Task 5's fresh integration/security/state review or a later invitation-only pilot on a separate machine.
- No commit, push, worktree, dependency install, production restart, real Orca mutation, or production installation was performed. Owned temp package fixtures are removed after evidence capture.

## Changed paths

- Web: `apps/web/e2e/operations-console.spec.ts`, `src/{api.ts,api.test.ts,app.tsx,app.test.tsx,styles.css}`, `src/routes/{operations-compose,operations-detail,operations-list,operations-questions}.tsx`; deleted `e2e/mobile-dashboard.spec.ts`.
- Gateway: `src/{managed-service,operations-assets}.ts`, `test/{end-to-end,managed-service,operations-assets,operations-journal}.test.ts`.
- Installer/root/docs: `packages/installer/src/{cli,index,console}.ts`, `packages/installer/test/{cli,console,documented-commands}.test.ts`, root `package.json`, `README.md`, progress report, screenshots, this report, and the scoped overlay.
- Focused regression: `packages/core/src/public-output.ts`, `apps/gateway/src/progress-events.ts`, and `apps/gateway/test/progress-events.test.ts`.
