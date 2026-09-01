# Orca HQ Foundation and Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the typed monorepo, durable command store, curated project registry, routing policy, risk policy, and worktree lock service that every Orca HQ adapter uses.

**Architecture:** A pnpm workspace exposes small TypeScript packages with Zod schemas at every external or persisted boundary. SQLite is the durable source of truth; channels and agent providers interact only through typed ports in `packages/core`.

**Tech Stack:** Node.js 22, pnpm 9, TypeScript strict mode, Zod, better-sqlite3, Vitest, Pino

## Global Constraints

- Host platform is macOS; Node.js is 22.20 or a compatible Node.js 22 LTS release and pnpm is 9.15 or a compatible pnpm 9.
- Orca is 1.4.194 or a compatible newer version; capabilities are detected at runtime.
- HQ authority belongs only to Codex; Claude Code is a worker and verifier provider.
- L0 is read-only, L1 is isolated edit/test, L2 is commit/push/PR, and L3 is merge/deploy/database/delete/secret/production.
- Telegram can request only L0/L1 and can never approve L2/L3.
- Runtime state and secrets stay outside Git; credentials live in macOS Keychain.
- SQLite uses WAL mode, foreign keys, versioned migrations, and transactional writes.
- Tests are written before implementation and each task ends with an independently testable commit.

---

### Task 1: Workspace, build, and test contract

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/workspace.test.ts`

**Interfaces:**
- Consumes: Node.js and pnpm version floors from the approved design.
- Produces: workspace scripts `build`, `typecheck`, `test`, and package export `@orca-hq/core`.

- [ ] **Step 1: Add the failing workspace smoke test**

```ts
// packages/core/test/workspace.test.ts
import { describe, expect, it } from "vitest";
import { ORCA_HQ_PROTOCOL_VERSION } from "../src/index.js";

describe("workspace", () => {
  it("exports one explicit protocol version", () => {
    expect(ORCA_HQ_PROTOCOL_VERSION).toBe(1);
  });
});
```

- [ ] **Step 2: Add workspace manifests and run the test to prove the export is absent**

```json
// package.json
{
  "name": "orca-hq",
  "private": true,
  "packageManager": "pnpm@9.15.5",
  "engines": { "node": ">=22.20 <23" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.8.3",
    "vitest": "^3.2.4"
  }
}
```

Run: `corepack enable && pnpm install && pnpm test packages/core/test/workspace.test.ts`

Expected: FAIL because `ORCA_HQ_PROTOCOL_VERSION` is not exported.

- [ ] **Step 3: Add the strict compiler contract and minimal export**

```ts
// packages/core/src/index.ts
export const ORCA_HQ_PROTOCOL_VERSION = 1 as const;
```

`tsconfig.base.json` must set `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `module: "NodeNext"`, and `moduleResolution: "NodeNext"`. `packages/core/package.json` must export `./dist/index.js` and provide `build` and `typecheck` scripts using `tsc`.

- [ ] **Step 4: Verify the workspace**

Run: `pnpm test packages/core/test/workspace.test.ts && pnpm typecheck && pnpm build`

Expected: all commands exit 0 and `packages/core/dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts .gitignore packages/core
git commit -m "build: initialize Orca HQ workspace"
```

### Task 2: Core command, identity, proposal, and approval schemas

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/command.ts`
- Create: `packages/core/src/identity.ts`
- Create: `packages/core/src/proposal.ts`
- Create: `packages/core/src/approval.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schemas.test.ts`

**Interfaces:**
- Consumes: Zod v3 schema validation.
- Produces: `CommandEnvelopeSchema`, `PrincipalBindingSchema`, `ExecutionProposalSchema`, `ApprovalRecordSchema`, and inferred TypeScript types with the same names minus `Schema`.

- [ ] **Step 1: Write boundary-schema tests**

```ts
import { describe, expect, it } from "vitest";
import { CommandEnvelopeSchema, ExecutionProposalSchema } from "../src/index.js";

describe("core schemas", () => {
  it("rejects a route score outside the closed interval", () => {
    const parsed = ExecutionProposalSchema.safeParse({
      proposalId: "p1", commandId: "c1", selectedProjectKey: "web",
      routeCandidates: [{ projectKey: "web", score: 1.1, evidence: ["alias"] }],
      allowedScope: ["src/**"], prohibitedEffects: ["push"], acceptanceCommands: ["pnpm test"],
      riskLevel: "L2", tasks: []
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a provider message identity", () => {
    expect(CommandEnvelopeSchema.safeParse({ channel: "slack", text: "status" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm missing exports**

Run: `pnpm test packages/core/test/schemas.test.ts`

Expected: FAIL because the schemas are not defined.

- [ ] **Step 3: Implement exact schemas**

```ts
// packages/core/src/command.ts
import { z } from "zod";

export const ChannelSchema = z.enum(["slack", "telegram", "tailscale-web"]);
export const CommandEnvelopeSchema = z.object({
  commandId: z.string().min(1), idempotencyKey: z.string().min(1), channel: ChannelSchema,
  externalMessageId: z.string().min(1), externalThreadId: z.string().min(1).optional(),
  principalId: z.string().min(1), receivedAt: z.string().datetime(), text: z.string().min(1),
  attachments: z.array(z.object({
    provider: z.literal("slack"), providerFileId: z.string().min(1), name: z.string().min(1),
    mimeType: z.string().min(1).optional(), sizeBytes: z.number().int().nonnegative().optional(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).strict()).max(10).optional(),
  transcript: z.object({
    provider: z.enum(["openai", "local-whisper"]), sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    confidence: z.number().min(0).max(1).optional()
  }).optional()
}).strict();
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
```

`proposal.ts` must define the approved `RiskLevel`, route candidate, task role, preferred agent, and exact `ExecutionProposal` fields from the design. Route scores must be between 0 and 1. Channel permission is evaluated from the persisted Command context by the policy engine, not duplicated inside the proposal. `approval.ts` must include `proposalDigest`, `principalId`, `channel`, `expiresAt`, and optional `typedPhraseDigest`; `identity.ts` must expose owner/operator/viewer roles.

- [ ] **Step 4: Verify runtime parsing and TypeScript inference**

Run: `pnpm test packages/core/test/schemas.test.ts && pnpm typecheck`

Expected: PASS with no casts to `any` and no compiler errors.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml packages/core
git commit -m "feat(core): define control-plane schemas"
```

### Task 3: Durable SQLite command, inbox, outbox, and audit store

**Files:**
- Create: `packages/persistence/package.json`
- Create: `packages/persistence/src/database.ts`
- Create: `packages/persistence/src/migrations/001-initial.ts`
- Create: `packages/persistence/src/store.ts`
- Create: `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/store.test.ts`

**Interfaces:**
- Consumes: `CommandEnvelope` from `@orca-hq/core`.
- Produces: `openDatabase(path): Database`, `ControlStore.insertCommand(command): "inserted" | "duplicate"`, `enqueueOutbox`, `claimOutbox`, `appendAudit`, and `migrate`.

- [ ] **Step 1: Write transactional idempotency and outbox tests**

```ts
it("inserts one command and one inbox event for duplicate delivery", () => {
  const store = testStore();
  expect(store.insertCommand(command)).toBe("inserted");
  expect(store.insertCommand(command)).toBe("duplicate");
  expect(store.listCommands()).toHaveLength(1);
  expect(store.listInboxEvents()).toHaveLength(1);
});

it("does not lose an outbox message across reopen", () => {
  const path = temporaryDatabasePath();
  createStore(path).enqueueOutbox(outboxMessage);
  expect(createStore(path).claimOutbox(new Date().toISOString())).toMatchObject({ id: outboxMessage.id });
});
```

- [ ] **Step 2: Run tests against the absent package**

Run: `pnpm test packages/persistence/test/store.test.ts`

Expected: FAIL because `testStore` and `ControlStore` do not exist.

- [ ] **Step 3: Implement migration and store transactions**

```ts
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

insertCommand(command: CommandEnvelope): "inserted" | "duplicate" {
  return this.db.transaction(() => {
    const result = this.insertCommandStatement.run(commandToRow(command));
    if (result.changes === 0) return "duplicate";
    this.insertInboxStatement.run(command.commandId, "command_received", JSON.stringify(command));
    this.appendAudit({ subjectId: command.commandId, eventType: "command.accepted", data: {} });
    return "inserted";
  })();
}
```

The migration must create all logical tables named in design section 15, unique indexes on command idempotency keys and provider inbox IDs, and an outbox claim index on `(state, next_attempt_at)`. Persisted JSON must be parsed through Zod before return.

- [ ] **Step 4: Verify migration, reopen, rollback, and foreign keys**

Run: `pnpm test packages/persistence && pnpm typecheck`

Expected: duplicate delivery creates one DAG seed, reopening retains pending delivery, and a forced transaction error leaves no partial rows.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(persistence): add durable command store"
```

### Task 4: Curated Orca project registry and deterministic routing

**Files:**
- Create: `packages/project-registry/package.json`
- Create: `packages/project-registry/src/schema.ts`
- Create: `packages/project-registry/src/registry.ts`
- Create: `packages/project-registry/src/router.ts`
- Create: `packages/project-registry/src/index.ts`
- Create: `templates/projects.example.yaml`
- Test: `packages/project-registry/test/router.test.ts`

**Interfaces:**
- Consumes: approved project metadata imported by the Orca adapter as `DiscoveredProject[]`.
- Produces: `ProjectRegistryEntrySchema`, `Registry.load(path)`, and `routeProject(input, entries): RouteDecision` where decision is selected only at score `>= 0.85` and margin `>= 0.15`.

- [ ] **Step 1: Write exact selection and ambiguity tests**

```ts
it("selects an exact approved alias", () => {
  const result = routeProject({ text: "리스크제로 백엔드 테스트해줘" }, entries);
  expect(result).toEqual(expect.objectContaining({ kind: "selected", projectKey: "riskzero-api", score: 1 }));
});

it("asks when the winner margin is below 0.15", () => {
  const result = decideRankedRoute([
    { projectKey: "a", score: 0.9, evidence: ["model"] },
    { projectKey: "b", score: 0.8, evidence: ["model"] }
  ]);
  expect(result.kind).toBe("clarification_required");
});
```

- [ ] **Step 2: Run the routing tests and confirm failure**

Run: `pnpm test packages/project-registry/test/router.test.ts`

Expected: FAIL because routing functions do not exist.

- [ ] **Step 3: Implement schema validation and threshold routing**

```ts
export function decideRankedRoute(candidates: RouteCandidate[]): RouteDecision {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.score < 0.85 || (second && first.score - second.score < 0.15)) {
    return { kind: "clarification_required", candidates: ranked.slice(0, 3) };
  }
  return { kind: "selected", projectKey: first.projectKey, score: first.score, evidence: first.evidence };
}
```

Registry load must reject duplicate aliases, relative paths, missing required checks, unapproved imported projects, and allowed operations outside `L0`–`L3`. The example YAML must contain synthetic paths and remotes only.

- [ ] **Step 4: Verify registry failures and deterministic routes**

Run: `pnpm test packages/project-registry && pnpm typecheck`

Expected: exact aliases select, ambiguous routes ask, and company-specific or malformed entries are rejected.

- [ ] **Step 5: Commit**

```bash
git add packages/project-registry templates/projects.example.yaml pnpm-lock.yaml
git commit -m "feat(registry): add curated project routing"
```

### Task 5: Risk policy, digest-bound approvals, and worktree leases

**Files:**
- Create: `packages/core/src/policy.ts`
- Create: `packages/core/src/digest.ts`
- Create: `packages/project-registry/src/locks.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/project-registry/src/index.ts`
- Modify: `packages/persistence/src/store.ts`
- Test: `packages/core/test/policy.test.ts`
- Test: `packages/project-registry/test/locks.test.ts`

**Interfaces:**
- Consumes: `ExecutionProposal`, `ApprovalRecord`, project `allowedOperations`, and SQLite transactions.
- Produces: `classifyRisk`, `proposalDigest`, `approvalOperationDigest`, `authorizeProposal`, `WorktreeLockService.acquire/heartbeat/release`, and immutable policy decisions.

- [ ] **Step 1: Write policy-matrix and lock-conflict tests**

```ts
it.each([
  ["telegram", "L1", "auto"], ["telegram", "L2", "rejected"],
  ["slack", "L2", "approval_required"], ["tailscale-web", "L3", "approval_required"]
] as const)("maps %s %s to %s", (channel, riskLevel, outcome) => {
  expect(authorizeProposal(proposal({ riskLevel }), { ...context, channel }).kind).toBe(outcome);
});

it.each([
  ["inspect_status", "L0"], ["edit_isolated_worktree", "L1"], ["create_pull_request", "L2"],
  ["deploy_production", "L3"], ["delete_data", "L3"], ["read_secret", "L3"]
] as const)("classifies %s as %s", (operation, expected) => {
  expect(classifyRisk(operation)).toBe(expected);
});

it("allows one editing lease per lock key", () => {
  expect(locks.acquire(lease("repo:a", "dispatch:1")).kind).toBe("acquired");
  expect(locks.acquire(lease("repo:a", "dispatch:2")).kind).toBe("conflict");
});
```

- [ ] **Step 2: Run tests and verify the missing policy boundary**

Run: `pnpm test packages/core/test/policy.test.ts packages/project-registry/test/locks.test.ts`

Expected: FAIL because authorization and leases are undefined.

- [ ] **Step 3: Implement canonical proposal digest and fail-closed policy**

```ts
export function proposalDigest(proposal: ExecutionProposal): string {
  const immutable = {
    proposalId: proposal.proposalId, commandId: proposal.commandId,
    selectedProjectKey: proposal.selectedProjectKey, baseRef: proposal.baseRef ?? null,
    allowedScope: [...proposal.allowedScope].sort(), prohibitedEffects: [...proposal.prohibitedEffects].sort(),
    acceptanceCommands: [...proposal.acceptanceCommands], riskLevel: proposal.riskLevel, tasks: proposal.tasks
  };
  return createHash("sha256").update(canonicalize(immutable)).digest("hex");
}

export function approvalOperationDigest(input: ApprovalOperationInput): string {
  return createHash("sha256").update(canonicalize({
    proposalDigest: input.proposalDigest,
    operation: input.operation,
    commandDigest: input.commandDigest,
    diffSha256: input.diffSha256 ?? null,
    targetEnvironment: input.targetEnvironment ?? null
  })).digest("hex");
}
```

`authorizeProposal` must return only `auto`, `approval_required`, or `rejected`; validate channel, principal role, project allowlist, expiry, and exact digest. Unknown operations fail closed as L3. Approval input contains the current diff hash and target environment outside the initial proposal because those values may exist only after L1 work finishes. `WorktreeLockService` must use one immediate SQLite transaction and compare heartbeat expiry before replacing a lease. It must never treat expiry alone as proof that a live worker is gone; expired locks return `review_required` until Orca/Git reconciliation confirms safety.

- [ ] **Step 4: Run the complete control-plane suite**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all suites pass; changing project, base, scope, command, environment, or acceptance command invalidates approval; conflicting edits remain blocked.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/project-registry packages/persistence
git commit -m "feat(policy): enforce approvals and worktree leases"
```

## Plan 1 Completion Gate

Run: `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm build`

Expected evidence:

- Duplicate provider delivery persists exactly one command and inbox event.
- Registry routing selects only above both approved thresholds.
- Telegram L2/L3 is rejected before any adapter or agent call.
- Approval is valid only for its exact digest and 15-minute window.
- A conflicting edit lease cannot be acquired automatically.
