# Orca HQ Agent Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Codex HQ to the public Orca CLI, execute isolated Codex and Claude Code workers, supervise lifecycle messages, and require cross-model verification before success.

**Architecture:** The Orca adapter invokes only version-matched public CLI JSON commands and validates receipts. Codex HQ emits a structured proposal through constrained ports; deterministic services enforce policy, create Runs/Tasks/Dispatches, and route each implementation to the opposite model family for read-only verification.

**Tech Stack:** Orca CLI, Codex CLI, Claude Code CLI, TypeScript, Zod, SQLite, Vitest, sandbox Git fixtures

## Global Constraints

- Orca is 1.4.194 or a compatible newer version and its current `orca-cli` and `orchestration` skills are loaded at runtime.
- No code accesses Orca's private database, undocumented RPC interfaces, or cached command grammar.
- Codex using GPT-5.6 Sol is the sole HQ authority; GPT-5.6 Terra may classify or summarize only.
- Codex and Claude Code are worker peers; nested worker creation is disabled.
- Codex implementation is verified by Claude Code and Claude implementation is verified by Codex.
- `worker_done` is not user-visible success; verification and acceptance evidence are required.
- One proven launch failure permits one conflict-free retry; a second launch failure requires intervention.
- Two failed fix-and-verify cycles require intervention.

---

### Task 1: Versioned Orca CLI capability and receipt adapter

**Files:**
- Create: `packages/orca-adapter/package.json`
- Create: `packages/orca-adapter/src/process.ts`
- Create: `packages/orca-adapter/src/capabilities.ts`
- Create: `packages/orca-adapter/src/receipts.ts`
- Create: `packages/orca-adapter/src/index.ts`
- Create: `packages/test-support/package.json`
- Create: `packages/test-support/tsconfig.json`
- Create: `packages/test-support/src/fake-orca.ts`
- Create: `packages/test-support/src/index.ts`
- Create: `packages/orca-adapter/test/fixtures/status-1.4.194.json`
- Test: `packages/orca-adapter/test/capabilities.test.ts`

**Interfaces:**
- Consumes: executable path, abort signal, expected Orca version range, and current skill text returned by Orca.
- Produces: `OrcaClient.health()`, `discoverProjects()`, `loadSkill(name)`, `execute(operation)`, and Zod-validated `OrcaReceipt` values.

- [ ] **Step 1: Write capability and malformed-receipt tests**

```ts
it("accepts 1.4.194 with required JSON operations", async () => {
  await expect(client.health()).resolves.toMatchObject({ compatible: true, version: "1.4.194" });
});

it("rejects prose where a JSON receipt is required", async () => {
  fakeOrca.stdout = "worker started";
  await expect(client.execute({ kind: "list_projects" })).rejects.toMatchObject({ code: "invalid_orca_receipt" });
});
```

- [ ] **Step 2: Run tests against the missing adapter**

Run: `pnpm test packages/orca-adapter/test/capabilities.test.ts`

Expected: FAIL because `OrcaClient` does not exist.

- [ ] **Step 3: Implement safe process execution and receipt parsing**

```ts
export async function runOrca(args: readonly string[], signal: AbortSignal): Promise<unknown> {
  const result = await execa("orca", [...args, "--json"], { signal, reject: false, shell: false });
  if (result.exitCode !== 0) throw OrcaProcessError.from(result);
  return JSON.parse(result.stdout);
}
```

Argument arrays must come from typed operations, never model-authored shell strings. Startup loads both official skills, records their hashes with the Orca version, and marks health incompatible when required Run/Task/Dispatch/worker lifecycle capabilities are absent.

- [ ] **Step 4: Verify supported, unsupported, timeout, and stale-handle fixtures**

Run: `pnpm test packages/orca-adapter && pnpm typecheck`

Expected: every receipt is schema-checked and an incompatible version prevents all mutations.

- [ ] **Step 5: Commit**

```bash
git add packages/orca-adapter packages/test-support pnpm-lock.yaml
git commit -m "feat(orca): add public CLI adapter"
```

### Task 2: Codex HQ structured session protocol

**Files:**
- Create: `packages/codex-hq/package.json`
- Create: `packages/codex-hq/src/session.ts`
- Create: `packages/codex-hq/src/tools.ts`
- Create: `packages/codex-hq/src/protocol.ts`
- Create: `packages/codex-hq/src/index.ts`
- Test: `packages/codex-hq/test/session.test.ts`

**Interfaces:**
- Consumes: one command, registry query port, policy preview port, Codex CLI JSON event stream, and GPT-5.6 Sol/Terra model configuration.
- Produces: exactly one Zod-valid `ExecutionProposal`, clarification request, or typed HQ failure per command.

- [ ] **Step 1: Write authority and schema tests**

```ts
it("accepts one valid proposal and closes the turn", async () => {
  const result = await session.plan(command);
  expect(result.kind).toBe("proposal");
  expect(ExecutionProposalSchema.parse(result.proposal)).toBeTruthy();
});

it("queues a command when Codex authentication is unavailable", async () => {
  codex.failWith("authentication_required");
  await expect(session.plan(command)).resolves.toEqual({ kind: "degraded", reason: "codex_unavailable" });
  expect(claude.invoke).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and confirm no HQ fallback exists**

Run: `pnpm test packages/codex-hq/test/session.test.ts`

Expected: FAIL because the HQ session protocol is absent.

- [ ] **Step 3: Implement constrained tools and one-command serialization**

```ts
export const hqTools = {
  searchProjects: SearchProjectsInputSchema,
  inspectProject: InspectProjectInputSchema,
  previewPolicy: PreviewPolicyInputSchema,
  submitProposal: ExecutionProposalSchema,
  askClarification: ClarificationSchema
} as const;
```

The Codex process must have no direct channel credential, Keychain dump, approval write, or unrestricted routing shell tool. A mutex admits one active coordinator turn; commands remain durable and ordered while busy. Terra output can contribute labels or summaries but cannot select a final project, change risk, approve, or dispatch.

- [ ] **Step 4: Verify malformed model output and degraded mode**

Run: `pnpm test packages/codex-hq && pnpm typecheck`

Expected: malformed output becomes a typed failure, low route confidence becomes clarification, and Claude never assumes HQ authority.

- [ ] **Step 5: Commit**

```bash
git add packages/codex-hq pnpm-lock.yaml
git commit -m "feat(hq): add Codex coordination protocol"
```

### Task 3: Run, Task, Dispatch, and isolated worktree execution service

**Files:**
- Create: `packages/worker-routing/package.json`
- Create: `packages/worker-routing/src/execution-service.ts`
- Create: `packages/worker-routing/src/worktree-placement.ts`
- Create: `packages/worker-routing/src/lifecycle.ts`
- Create: `packages/worker-routing/src/index.ts`
- Create: `packages/test-support/src/sandbox-repo.ts`
- Test: `packages/worker-routing/test/execution-service.test.ts`

**Interfaces:**
- Consumes: authorized proposal, `OrcaClient`, Registry entry, lock service, Git occupancy probe, and persisted Run/Task/Dispatch stores.
- Produces: `ExecutionService.start(proposal)`, isolated worktree placement, receipt-linked lifecycle state, questions, and exactly-once worker reports.

- [ ] **Step 1: Write dirty checkout, occupancy, and DAG-order tests**

```ts
it("creates tasks before dispatching ready workers", async () => {
  await service.start(proposalWithDependency());
  expect(orca.calls.map(c => c.kind)).toEqual(["create_run", "create_task", "create_task", "dispatch_worker"]);
});

it("blocks a branch already checked out elsewhere", async () => {
  gitProbe.branchOccupancy.mockResolvedValue([{ path: "/tmp/other", branch: "feature/a" }]);
  await expect(service.start(proposal)).resolves.toMatchObject({ kind: "review_required" });
  expect(orca.dispatchWorker).not.toHaveBeenCalled();
});

it("runs L0 read-only work without an editing lease or new worktree", async () => {
  await service.start(readOnlyProposal);
  expect(locks.acquire).not.toHaveBeenCalled();
  expect(placements.createWorktree).not.toHaveBeenCalled();
  expect(orca.dispatchWorker).toHaveBeenCalledWith(expect.objectContaining({ permissions: "read-only" }));
});
```

- [ ] **Step 2: Run tests and confirm lifecycle service absence**

Run: `pnpm test packages/worker-routing/test/execution-service.test.ts`

Expected: FAIL because worktree placement and dispatch orchestration are undefined.

- [ ] **Step 3: Implement deterministic preflight and lifecycle transitions**

```ts
async start(proposal: AuthorizedProposal): Promise<ExecutionStart> {
  const placement = await this.placements.resolve(proposal);
  if (placement.kind !== "ready") return placement;
  const lease = this.locks.acquire(toLease(proposal, placement));
  if (lease.kind !== "acquired") return lease;
  const run = await this.orca.createRun(toRunInput(proposal));
  const tasks = await this.createAllTasks(run, proposal.tasks);
  await this.dispatchReady(tasks, placement, lease);
  return { kind: "started", runId: run.runId };
}
```

Each worker input must state exact project, worktree, base, file scope, acceptance commands, prohibited effects, Task ID, and Dispatch ID. L0 investigation uses a read-only assignment without an editing lease; L1 or higher editing uses the isolated placement and lock path. Current uncommitted work requires an explicit current-worktree approval. Worker completion is persisted once and duplicate receipts are ignored.

- [ ] **Step 4: Verify sandbox Git placement and lifecycle contracts**

Run: `pnpm test packages/worker-routing packages/orca-adapter && pnpm typecheck`

Expected: independent work gets a top-level worktree, conflicts block before mutation, dependencies dispatch in order, and completion alone emits no success report.

- [ ] **Step 5: Commit**

```bash
git add packages/worker-routing packages/test-support
git commit -m "feat(execution): supervise isolated Orca workers"
```

### Task 4: Codex and Claude Code worker provider routing

**Files:**
- Create: `packages/worker-routing/src/providers.ts`
- Create: `packages/worker-routing/src/codex-worker.ts`
- Create: `packages/worker-routing/src/claude-worker.ts`
- Modify: `packages/worker-routing/src/execution-service.ts`
- Test: `packages/worker-routing/test/providers.test.ts`

**Interfaces:**
- Consumes: preferred agent, provider capability probes, task role, and immutable worker assignment.
- Produces: `WorkerProvider.start(assignment)`, `WorkerProvider.inspect(dispatchId)`, explicit provider receipts, and no silent provider substitution.

- [ ] **Step 1: Write provider and nested-agent prohibition tests**

```ts
it.each(["codex", "claude"] as const)("passes immutable assignment to %s", async provider => {
  await providers.get(provider).start(assignment);
  expect(processes.lastArgs()).toContainEqual(expect.stringContaining(assignment.dispatchId));
});

it("does not substitute Claude for an unavailable Codex HQ", async () => {
  capabilities.codexHq = false;
  expect(selectProvider({ role: "hq", preferredAgent: "codex" }, capabilities)).toEqual({ kind: "unavailable" });
});
```

- [ ] **Step 2: Run provider tests and observe missing implementations**

Run: `pnpm test packages/worker-routing/test/providers.test.ts`

Expected: FAIL because the provider implementations are absent.

- [ ] **Step 3: Implement explicit CLI argument construction**

```ts
export function providerFor(assignment: WorkerAssignment): WorkerProviderId {
  return assignment.preferredAgent;
}

export function workerPrompt(a: WorkerAssignment): string {
  return WorkerAssignmentSchema.parse(a) && JSON.stringify({
    protocol: 1, assignment: a, nestedWorkers: "forbidden", reportExactlyOnce: true
  });
}
```

The provider process runs in the assigned worktree with a bounded environment allowlist. Credentials are inherited only through the provider's normal authenticated CLI mechanism. No provider receives Slack, Telegram, Tailscale, or OpenAI voice secrets.

- [ ] **Step 4: Verify provider fixtures and process failure classification**

Run: `pnpm test packages/worker-routing && pnpm typecheck`

Expected: provider selection is deterministic, process output is validated, and nested worker requests are rejected by policy.

- [ ] **Step 5: Commit**

```bash
git add packages/worker-routing
git commit -m "feat(workers): support Codex and Claude providers"
```

### Task 5: Cross-model verification, fix cycles, and completion gate

**Files:**
- Create: `packages/worker-routing/src/verifier.ts`
- Create: `packages/worker-routing/src/completion-gate.ts`
- Modify: `packages/worker-routing/src/lifecycle.ts`
- Modify: `packages/persistence/src/store.ts`
- Test: `packages/worker-routing/test/verifier.test.ts`

**Interfaces:**
- Consumes: implementation provider, requested scope, changed files, Git diff, test receipts, prohibited effects, and worker result.
- Produces: opposite-family verifier Task, `VerificationReport`, separate Fix Task, and final `verified_success` only after evidence passes.

- [ ] **Step 1: Write pairing and failure-cycle tests**

```ts
it.each([["codex", "claude"], ["claude", "codex"]] as const)("pairs %s implementation with %s verifier", (worker, verifier) => {
  expect(selectVerifier(worker)).toBe(verifier);
});

it("never reports success after failed verification", async () => {
  verifier.complete(report({ verdict: "fail" }));
  expect(outbox.messages).not.toContainEqual(expect.objectContaining({ template: "success" }));
  expect(store.listTasks()).toContainEqual(expect.objectContaining({ role: "implement", title: expect.stringContaining("Fix") }));
});
```

- [ ] **Step 2: Run tests and confirm success is not gated**

Run: `pnpm test packages/worker-routing/test/verifier.test.ts`

Expected: FAIL because verifier pairing and the completion gate are missing.

- [ ] **Step 3: Implement read-only verification and bounded fix cycles**

```ts
export function selectVerifier(implementer: WorkerProviderId): WorkerProviderId {
  return implementer === "codex" ? "claude" : "codex";
}

export function completionDecision(report: VerificationReport, cycle: number): CompletionDecision {
  if (report.verdict === "pass") return { kind: "verified_success", evidence: report.evidence };
  if (cycle < 2) return { kind: "create_fix_task", findings: report.findings, nextCycle: cycle + 1 };
  return { kind: "intervention_required", findings: report.findings };
}
```

Verifier assignment permits repository reads and acceptance commands but prohibits file writes, commit, push, PR, merge, deployment, secrets, and production. The final report must include project route, diff summary, commands and results, implementation provider, verifier provider, and audit references.

- [ ] **Step 4: Run execution, verification, and sandbox integration suites**

Run: `pnpm test packages/orca-adapter packages/codex-hq packages/worker-routing packages/test-support && pnpm typecheck && pnpm build`

Expected: both pairing directions pass, a failed verifier creates a Fix Task, two failed cycles require intervention, and no unverified success reaches Outbox.

- [ ] **Step 5: Commit**

```bash
git add packages/worker-routing packages/persistence
git commit -m "feat(verification): require cross-model evidence"
```

## Plan 3 Completion Gate

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected evidence:

- Orca mutations use public version-matched JSON commands only.
- Codex is the only coordinator and degraded mode never promotes Claude to HQ.
- Editing workers run in conflict-free isolated worktrees with persisted receipts.
- Codex and Claude can each implement a sandbox Task.
- Every implementation is checked by the other model family before success.
