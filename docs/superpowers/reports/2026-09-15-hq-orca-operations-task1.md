# Task 1 — Shared contract and public adapter

Status: fix round 2 implemented and focused verification passed; independent review pending; Task 2 has not started.

## Public contract for Task 2

Core exports strict Zod schemas and matching inferred types:

- `EvidenceSchema/Evidence`, `SupportSchema/Support`, and `OperationsStatusSchema/OperationsStatus`.
- `HqContextPageSchema/HqContextPage` contains at most 100 sanitized current `ContextSnapshot` records plus optional cursor/compaction.
- `HqEventPageSchema/HqEventPage` preserves events, snapshots, oldest/latest sequence, compaction, and optional cursor. Each event is tagged `source:"hq"`, preserves original `eventSource`, `agentId?`, and `generation?`; `receiptLink` is legal only for `worker.ready|worker.retained`.
- `HqQuestionSchema/HqQuestion` and `OrcaQuestionSchema/OrcaQuestion` keep source identities separate and redact public body text.
- `OrcaRunPageSchema/OrcaRunPage`, `OrcaTaskPageSchema/OrcaTaskPage`, and `OrcaWorkerPageSchema/OrcaWorkerPage` cap lists at 100; `OrcaWorkerDetailSchema/OrcaWorkerDetail` keeps liveness, PTY observation, terminal evidence, outcome, and settlement separate.
- `OrcaOutputPageSchema/OrcaOutputPage` is an exact discriminated union: transcript has only `messages`, terminal has only `lines`; both cap content at 500 and sanitize/redact public strings.
- `OrcaResourceInventorySchema/OrcaResourceInventory` is project → host setup → worktree → terminal, with 100-row caps at each public inventory level.
- `OperationsMutationReceiptSchema/OperationsMutationReceipt` exposes bounded `requestId,action,targetId,state,observedAt,detail?`.
- `sanitizeDisplayText`, `sanitizeResultText`, and `redactPublicText`; credentials are removed before the 64-KiB result bound, including unterminated private-key blocks.

Adapter exports `OrcaOperationsReceiptSchema`, `OrcaOperationsReceipt`, `OrcaOperationsReceiptKind`, and `parseOrcaOperationsReceipt(kind, value)`. Every new operation has an operation-specific result schema; legacy operations and parsers remain unchanged. `OrcaClient.execute` verifies returned task/Dispatch identity for lifecycle controls, reply thread/question/answer identity, send recipient identity, and returned mutation request identity.

## Exact public CLI mapping

- Reads: `status`; `orchestration run-list/run-show --id/task-list --run --brief/worker-list/worker-read/inbox`; `project list/setups --project`; `worktree list --repo id:<repoId>/show`; `terminal list/show/read`.
- Controls: `dispatch --task --to`, `reply --id --body`, `send --subject "HQ operator follow-up" --to dispatch:<id> --type status --body`, and worker stop/retain/release. All controls map `retryRequestId` to `--retry-request`.
- `runOrca` alone appends one `--json`, uses `shell:false`, a bounded environment, timeout/abort handling, and a 2-MiB default output cap. Overflow stops buffering and uses the same one-shot SIGTERM → grace → SIGKILL path.

## Verification

- RED phase: 7 focused failures reproduced wrong argv/input limits, lost event/link rules, output XOR, truncation-before-redaction, generic receipts, and overflow waiting until timeout; a separate mutation-identity regression also failed before its fix.
- `pnpm vitest run packages/core/test/operations.test.ts packages/core/test/public-output.test.ts packages/orca-adapter/test/operations.test.ts packages/orca-adapter/test/process.test.ts packages/orca-adapter/test/capabilities.test.ts apps/gateway/test/progress-events.test.ts packages/installer/test/progress-client.test.ts`: 7 files, 73 tests passed.
- Core, Orca adapter, and installer typechecks passed.

## Files

Task 1 code/tests: `packages/core/src/{index,operations,public-output}.ts`, `packages/core/test/{operations,public-output}.test.ts`, `packages/installer/src/progress-client.ts`, `apps/gateway/src/progress-events.ts`, `packages/orca-adapter/src/{capabilities,process,index,receipts}.ts`, and `packages/orca-adapter/test/{operations,process}.test.ts`.

## Fix round 2 evidence

- Scope: only the two remaining Spec/Quality findings in `2026-09-15-hq-orca-operations-task1-rereview.md`; no Task 2 or legacy parser changes.
- Authoritative reply shape: Orca 1.4.203 coordinator reply to evidence question `msg_af1d64d147f0`, relayed in `msg_5c6866844d09`; actual message `msg_3402deb07500`, mutation request `8ad30ddf-1151-42e0-8391-7d30c239505b`. Result contains typed `message`, optional/null `question`, `duplicate`, and `mutation`; reply target is `message.thread_id`, plus `question.message_id` when present. The fixture uses this observed shape with synthetic values.
- New reply/message schemas validate bounded identities/text and question answer fields; execution verifies thread/question target, answer-message identity, send Dispatch recipient, and retry request identity. Tests cover target/request mismatches across all six controls.
- New operations-only worker-read discriminated union requires exactly source-matching transcript/terminal content, caps pages at 500, warnings at 100, IDs at 512, cursors at 2048, and terminal strings/serialized transcript blocks at 64 KiB. Lifecycle state/verdict reject whitespace-only values. Legacy worker-read remains unchanged.
- RED: focused tests reproduced accepted `reply:42`, source/content mismatch, malformed message/question objects, and execution accepting a different reply target. Original blank-verdict probe was independently reproduced in the re-review; its regression now covers all three lifecycle controls.
- GREEN: `pnpm vitest run packages/orca-adapter/test/operations.test.ts packages/core/test/operations.test.ts` — 12 passed. Forbidden links are tested on an otherwise-valid page; worker.ready and worker.retained are both accepted.
- Compatibility: `pnpm vitest run packages/orca-adapter/test/capabilities.test.ts -t 'maps lifecycle operations|rejects an empty result|marks a malformed worker-start'` — 3 passed, 23 intentionally skipped. The earlier 73-test suite was not repeated.
- Typechecks passed: adapter package source typecheck, direct strict NodeNext/ES2022 typecheck of adapter operations tests, and core `typecheck:test`. Exact source/test diff whitespace check passed.
- Artifacts: full 13-path `task1.diff` refreshed; `task1-fix2.diff` contains only this round's four code/test files and two report/progress updates against explicit pre-edit snapshots. No real control operation was used for probing; process integration tests used fake Orca.

Remaining work: independent fix-round-2 review; Task 2 stays pending and must implement fresh-state authorization/idempotency and an explicit trusted sender context (the observed coordinator reply required `--from`).
