# Native Orca agents — Task 1 result

## Outcome

Task 1 is implemented without runtime, admission, configuration, build, install, restart, commit, push, or external-message changes. Core now exports strict Zod contracts for launch profiles, native work items, DAG plans, and worker receipts; the DAG rejects unknown, self, cyclic, and duplicate dependencies plus duplicate attempt identities. Existing shared/uncommitted work was preserved.

## Planner API for dependent tasks

`createNativeWorkPlanner({ profiles }).plan(input)` is the concrete Task 1 API.

- `profiles` is an injected `Record<string, LaunchProfile>` allowlist.
- `input.context` supplies trusted `requestId`, `contextId`, and `generation`.
- `input.attempts` supplies trusted `attemptId -> projectId` placement and an optional trusted `resumeTerminalHandle`.
- `input.projects` supplies trusted `projectId -> worktreeId` placement, an explicit trusted `checkoutResourceKey`, and allowed resource scopes/modes. The trusted caller supplies the observed worktree/primary-checkout pairing; Task 3 revalidates native placement at execution.
- `input.proposedItems` contains only `attemptId`, objective, access, requested resources, dependencies, and a `profileKey`.
- The planner derives request/context/generation/project/worktree/resume/profile fields, always derives the required primary checkout reservation, preserves authorized secondary checkouts, normalizes all resources through the existing reservation helper, rejects missing/unallowed primary scope or write escalation, then validates the final DAG through `NativeWorkPlanSchema`.

Task 2 can consume the returned `NativeWorkItem[]` for admission/reservations. Task 4 owns runtime wiring and durable attempt assignment before effects; Task 5 owns configuration.

## Progress and routing contracts

- Added `worker.launching`, `worker.ready`, `worker.retained`, and `worker.recovery_required`.
- Every native worker event requires context, generation, HQ attempt identity, trusted worktree placement, and requested profile. `ready`/`retained` require the complete native receipt; `launching`/`recovery_required` accept validated partial Orca observations because launch recovery may not have a complete receipt. Legacy event payloads remain accepted unchanged.
- Added a separately refined `ProgressEventInputSchema`; the progress store consumes it before SQL insertion, while `ProgressEventSchema` validates complete/read-back events.
- Global jobs lookup and context status/stop behavior remain inline. Mixed reply/work output is rejected; the router prompt classifies code analysis/review as work, while Task 4 retains ownership of enabling native-first runtime policy rather than relying on a broad keyword interceptor.
- The existing store path rejects malformed native events without leaving a persisted row; the coordinator-authorized focused store regression covers the store consumer that previously used `ProgressEventSchema.omit(...)` and now uses `ProgressEventInputSchema`.

## Verification

- RED: `pnpm exec vitest run packages/core/test/native-work.test.ts apps/gateway/test/native-work-planner.test.ts apps/gateway/test/context-router.test.ts packages/core/test/progress.test.ts` — failed as expected because both new modules were missing and native event kinds were invalid.
- GREEN (plan command): `pnpm exec vitest run packages/core/test/native-work.test.ts apps/gateway/test/native-work-planner.test.ts apps/gateway/test/context-router.test.ts` — 3 files passed, 20 tests passed.
- GREEN (progress): `pnpm exec vitest run packages/core/test/progress.test.ts` — 1 file passed, 5 tests passed.
- Focused store integration: `pnpm exec vitest run apps/gateway/test/native-work-planner.test.ts apps/gateway/test/progress-store.test.ts` — 2 files passed, 25 tests passed.
- Final fresh plan verification: `pnpm exec vitest run packages/core/test/native-work.test.ts apps/gateway/test/native-work-planner.test.ts apps/gateway/test/context-router.test.ts` — 3 files passed, 21 tests passed.
- Final fresh progress/store verification: `pnpm exec vitest run packages/core/test/progress.test.ts apps/gateway/test/progress-store.test.ts` — 2 files passed, 27 tests passed.
- `pnpm --filter @orca-hq/core typecheck` — passed.
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` — passed; this uses the repository source aliases and includes gateway source/tests.
- `pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --esModuleInterop --skipLibCheck packages/core/test/native-work.test.ts packages/core/test/progress.test.ts` — passed.
- `git diff --check -- packages/core/src/index.ts packages/core/src/progress.ts apps/gateway/src/context-router.ts apps/gateway/src/progress-store.ts apps/gateway/test/progress-store.test.ts` — passed. New untracked files were reviewed directly because `git diff --check` does not include them.

## Integration limitation

`pnpm --filter @orca-hq/gateway typecheck` by itself resolves `@orca-hq/core` from the pre-existing generated `packages/core/dist` declarations and therefore reports the four new core exports as missing until the normal dependency build order regenerates core declarations. No build was run because this task explicitly prohibited build side effects; the source-aliased no-emit root typecheck passes.

## Modified paths

- `packages/core/src/native-work.ts`
- `packages/core/test/native-work.test.ts`
- `packages/core/src/index.ts`
- `packages/core/src/progress.ts`
- `packages/core/test/progress.test.ts`
- `apps/gateway/src/native-work-planner.ts`
- `apps/gateway/test/native-work-planner.test.ts`
- `apps/gateway/src/context-router.ts`
- `apps/gateway/test/context-router.test.ts`
- `apps/gateway/src/progress-store.ts`
- `apps/gateway/test/progress-store.test.ts`
- `docs/superpowers/implementation/2026-09-08-native-orca-task1-result.md`

## Coordinator closeout

Orca Run `run_f91a539f0b6c`, Task `task_2c8d40c3c3b9`, Dispatch `ctx_0c1bb706d7be`; selected/effective worker was Codex gpt-5.6-sol high. Coordinator reviewed the final source changes against a pre-task allowlist snapshot and resolved the findings through this same worker. After succeeded worker_done, the exact worker was released, its transcript captured, and the final delivery acknowledged. Plan Task 1 checkboxes are complete; Task 2 remains next.
