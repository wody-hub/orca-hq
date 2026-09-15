# Task 2 independent spec and quality review

Date: 2026-09-15 KST
Spec: **BLOCK**
Quality: **BLOCK**

## Scope and evidence

- Reviewed the Task 2 report and explicit-baseline diff, the actual gateway/adapter wiring and focused tests, and only Global Constraints, Shared Contract, and Task 2 of the approved implementation plan.
- Reused the recorded **110 passing tests**, subsequent **37 passing tests**, gateway/adapter source checks, and focused test checks; these were not rerun or represented as fresh review results.
- Fresh checks were limited to two isolated source-method probes and the implicated test-support typecheck; no real Orca operation was invoked by a probe.

## Required fixes

### R1 — P2: Expiry is checked before asynchronous body consumption

- `apps/gateway/src/operations-http.ts:112–159` prunes claims/sessions before awaiting the POST body, then redeems by map membership without checking the deadline again.
- A request that begins while its claim is valid can complete after the 60-second deadline and still receive a session; an expired session can likewise survive the body-read interval until another request prunes it.
- Fresh probe loaded the actual transpiled `OperationsHttp` with an injected clock and asynchronous request body: claim deadline `61000`, redemption time `62000`, response **200**.
- Recheck claim/session deadlines after body parsing and immediately before redemption/authentication; keep claim consumption atomic and single-use. Add delayed-body claim and session expiry regressions (existing expiry tests advance time before request entry only).

### R2 — P2: HQ question pagination resets at the end

- `apps/gateway/src/operations-service.ts:138` returns `String(page.events.at(-1)?.seq ?? 0)` instead of preserving the incoming `after` on an empty page.
- This contradicts the published “continue event cursor until unchanged” contract: a populated history cycles from its last cursor back to zero and replays old pages indefinitely.
- Fresh probe extracted and executed the actual `questions` method against an empty-page store: `questions(37,100)` returned `cursor:"0"`.
- Preserve the incoming cursor on empty pages and test exhaustion/repeated polling, including a compacted history. Existing paging tests cover populated pages only.

### R3 — P2 integration follow-up: Expanded operation union breaks the legacy fake

- Fresh `pnpm exec tsc -p packages/test-support/tsconfig.json --noEmit --pretty false` fails with **TS2366** at `packages/test-support/src/fake-agents.ts:45:44`.
- Exact-path `git diff HEAD -- packages/test-support/src/fake-agents.ts` is empty; the HEAD file has the same eight-case `LaunchOrca.execute(operation: OrcaOperation): Promise<OrcaReceipt>` switch.
- Exact-path HEAD inspection of `packages/orca-adapter/src/capabilities.ts` shows those eight legacy variants covered exhaustively. The current union adds operations variants; Task 2's supplied baseline diff specifically adds `operations_show_worker` on top of the earlier operations expansion.
- Thus this is an integration regression from the expanded union, already present at Task 2's starting baseline and further extended here, not an independently broken legacy switch in HEAD. No whole-HEAD typecheck claim is made.
- Give the fake explicit unsupported-operation rejection or implement the newly supported cases as appropriate, then run its package typecheck and affected fake-agent consumers. Changing adapter test imports avoids loading the failure but does not fix it.
- This can be separate next integration work because the fake is outside the gateway runtime; it must remain tracked before repository-wide validation is claimed.

## Verified design and contract assessment

- Runtime constructs the trusted local adapter, uses the actual progress store/submission and admission provenance, and wires the HTTP service/journal to the existing listener and managed SQLite DB; socket issuance is behind owner-directory/socket permissions.
- Apart from R1, peer/Host/exact-Origin, cookie/CSRF, strict write inputs, single-use claims, body/output caps, security headers, bounded shell-free environment, and local connection selection are implemented at the actual boundary.
- The journal prepares before effects, serializes duplicate requests, hashes canonical input, rejects action/target/digest collisions, records bounded metadata, and persists/replays ambiguous and interrupted intent as unknown. Existing tests exercise these paths; recorded restart coverage uses journal reconstruction on an in-memory connection, not a fresh OS process.
- HQ reads use store snapshots/events without viewer leases; occupancy comes from HQ admission only. Receipt links remain restricted to complete ready/retained evidence. Native HQ answers route through existing HQ submission.
- Monitoring uses bounded public inbox reads, with no check/ack path. Native Run/task/worker fields, opaque outer output cursors, source tags, host omission evidence, sanitization, four-call concurrency and aggregate inventory limits are retained.
- Controls re-read runtime, Run owner, local sender, task creation incarnation/generation, and exact target/resource identity before effects. Dispatch/reply/send supply explicit server-selected sender/Run; lifecycle calls retain their supported public argv. Settlement and projection/PTY liveness remain separate, and uncertain evidence fails closed.
- Source-compatible refinements are justified: inventing Run status or authoritative pending-question state would misrepresent native evidence; separate operations worker parsing preserves legacy consumers. Optional adapter sender fields do not remove the gateway's mandatory sender proof, but union expansion needs R3's integration fix.
- The published routes are wired for Task 3 consumption, subject to R1/R2. No UI/launcher completion is implied. No additional task-scope blocking findings were established.

## Disposition

Fix R1/R2 and run their focused regressions before Task 2 passes; carry R3 explicitly into integration work and correct the implementation report's “pre-existing unrelated” attribution. Only this review and the progress review entry were edited; no code, protected document, unrelated artifact, commit, installation, or runtime mutation was performed.
