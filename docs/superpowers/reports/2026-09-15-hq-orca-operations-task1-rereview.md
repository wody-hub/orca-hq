# Task 1 fix round 1 — scoped independent re-review

## Verdict

**Spec: BLOCK. Quality: BLOCK.** Five prior findings are addressed; receipt validation and behavioral coverage remain incomplete.
Scope: prior Task 1 review, updated task1.md/task1.diff, and exact relevant implementation/test ranges only; no implementation changes or external mutations.
The supplied 73-test result was reused, not rerun. Read-only installed CLI help corroborated the corrected command surface.

## Prior Spec findings

1. **ADDRESSED — public CLI argv.** `packages/orca-adapter/src/capabilities.ts:153` now uses dispatch `--to`, reply `--id`, every control's `--retry-request`, and a constant send subject. Run-show uses `--id`; task-list removes unsupported limit and uses `--brief`; project list has a distinct operation; setups uses `project setups --project`; worktree list uses `--repo id:<repoId>` and supported `--limit`. Receipt arrays impose local caps where no CLI limit exists.
2. **ADDRESSED — HQ event/page fields and receipt links.** `packages/core/src/operations.ts:68` preserves eventSource, agentId, generation, snapshots, and sequence/compaction fields. Its refinement permits receiptLink only on worker.ready/worker.retained; original ProgressEvent/ProgressEventPage fields were checked narrowly.
3. **NOT ADDRESSED — typed receipts and identities (partial fix).** `packages/orca-adapter/src/receipts.ts:275` dispatches to operation-specific schemas and `src/index.ts:218` checks dispatch task identity, lifecycle Dispatch identity, and returned mutation request identity. However, reply payloads remain untyped, the newly wired worker-read parser accepts a source/content mismatch, and lifecycle state/verdict permit whitespace.
   - Confirmed with direct parser probes: operations_reply `{mutation:{requestId:"request",replayed:false},reply:42}` succeeds (`receipts.ts:264`). Merely requiring a reply/message key does not validate a reply receipt or its returned target identity.
   - Confirmed: operations_worker_read with `source:"transcript"` and only `terminal:{lines:["wrong source"],limited:false,nextCursor:"next"}` succeeds when other required base fields are supplied (`receipts.ts:145`, newly used at `:287`). The union does not tie source to its content; arrays also retain the legacy unbounded schemas.
   - Confirmed: operations_stop `{dispatchId:"dispatch",state:"   ",verdict:"   "}` succeeds (`receipts.ts:267`). A matching target can therefore carry no meaningful verdict.
   - Required: validate reply/message structure and returned target identities; use an operations-specific bounded worker-read source union; reject blank lifecycle state/verdict. Preserve legacy behavior separately if necessary.
4. **ADDRESSED — bounded operation inputs/output XOR.** `capabilities.ts:13` bounds new IDs/cursors/bodies and rejects blank input; `operations.ts:150` strictly discriminates transcript messages versus terminal lines with content caps. This shared output fix does not cure the adapter receipt issue above.

## Prior Quality findings

1. **ADDRESSED — redact before cap.** `packages/core/src/public-output.ts:27` strips controls and redacts the full input before bounding; the private-key pattern handles missing terminators. `packages/core/test/public-output.test.ts:18` covers both an oversized complete key and an unterminated key.
2. **ADDRESSED — output overflow cancellation.** `packages/orca-adapter/src/process.ts:186` discards the overflowing chunk and subsequent overflow output; cancellation is one-shot SIGTERM followed by grace-period SIGKILL. Rejection waits for child close. `packages/orca-adapter/test/process.test.ts:6` actually executes a SIGTERM-ignoring writer and requires output-limit rejection before the command timeout.
3. **NOT ADDRESSED — behavioral regression coverage (partial fix).** Corrected argv, negative input bounds, output XOR, key-boundary, real-child overflow, and one lifecycle target mismatch now have tests. But `packages/orca-adapter/test/operations.test.ts:40` only rejects empty results for most kinds; it misses all three accepted malformed receipts above.
   - `packages/core/test/operations.test.ts:28` tests forbidden receiptLink on a page missing snapshots, oldestSeq, and latestSeq. It throws even without the link-kind refinement, so it does not protect the rule. Supply an otherwise-valid page and cover both allowed kinds.
   - Add nonempty malformed receipt cases and returned request/reply-target mismatch coverage, alongside valid operation-specific fixtures.

## Fix-only breakage / remaining work

No additional confirmed breakage outside the two incomplete prior findings. The worker-read gap is relevant specifically because the fix now routes the new operation through the legacy permissive parser.
Complete the receipt boundary and regression assertions, then re-review those exact changes before Task 2 consumption.
