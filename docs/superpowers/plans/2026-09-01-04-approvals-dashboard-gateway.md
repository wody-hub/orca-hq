# Orca HQ Approvals, Dashboard, and Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add digest-bound Slack and Tailscale approvals, a private mobile dashboard, and the gateway composition root that drives the complete command lifecycle.

**Architecture:** A dedicated approval service owns immutable operation digests and expiry. Fastify exposes authenticated tailnet APIs to a React/Vite PWA; the gateway composes adapters through ports and a durable state machine, never through direct channel-to-Orca calls.

**Tech Stack:** Fastify, React, Vite, Tailscale Serve, Slack interactive actions, Zod, SQLite, Vitest, Playwright

## Global Constraints

- Slack and Tailscale web can approve L2/L3; Telegram cannot approve either level.
- Owner can approve L2/L3, operator can approve L2 only, and viewer cannot approve.
- L2/L3 approvals bind to an immutable operation digest and expire after 15 minutes.
- L3 requires typing a generated operation phrase and cannot be approved by one button.
- Tailscale Serve exposes the dashboard inside the tailnet only; Funnel and public binding are prohibited.
- Unknown tailnet identities or missing local sessions receive no project metadata.
- The dashboard distinguishes task completion, verification, and channel delivery states.
- Channel adapters create normalized commands and consume Outbox messages; they cannot call Orca directly.
- Every state transition appends an auditable, redacted event.

---

### Task 1: Approval request, confirmation, invalidation, and expiry service

**Files:**
- Create: `packages/core/src/approval-service.ts`
- Modify: `packages/core/src/approval.ts`
- Modify: `packages/persistence/src/store.ts`
- Test: `packages/core/test/approval-service.test.ts`

**Interfaces:**
- Consumes: immutable operation digest input, principal roles, channel, current time, operation phrase, and persisted approval row.
- Produces: `ApprovalService.request`, `confirm`, `validate`, `invalidate`, and typed decisions `approved | denied | expired | changed`.

- [ ] **Step 1: Write exact digest, expiry, and typed-phrase tests**

```ts
it("expires an L2 approval after 15 minutes", () => {
  const approval = service.confirm(request, owner, at("10:00:00"));
  expect(service.validate(approval.id, request.digest, at("10:15:01"))).toEqual({ kind: "expired" });
});

it("requires the generated phrase for L3", () => {
  expect(service.confirm(l3Request, owner, now, "APPROVE OTHER")).toEqual({ kind: "denied", reason: "phrase_mismatch" });
  expect(service.confirm(l3Request, owner, now, l3Request.operationPhrase).kind).toBe("approved");
});

it("allows operator for L2 but only owner for L3", () => {
  expect(service.confirm(l2Request, operator, now).kind).toBe("approved");
  expect(service.confirm(l3Request, operator, now, l3Request.operationPhrase)).toEqual({ kind: "denied", reason: "role" });
});
```

- [ ] **Step 2: Run tests and confirm service absence**

Run: `pnpm test packages/core/test/approval-service.test.ts`

Expected: FAIL because approval lifecycle methods do not exist.

- [ ] **Step 3: Implement fail-closed confirmation**

```ts
confirm(request: ApprovalRequest, actor: Principal, now: Date, phrase?: string): ApprovalDecision {
  if (!request.allowedChannels.includes(request.channel)) return { kind: "denied", reason: "channel_not_allowed" };
  const canApprove = request.riskLevel === "L3"
    ? actor.roles.includes("owner")
    : actor.roles.some(role => role === "owner" || role === "operator");
  if (!canApprove) return { kind: "denied", reason: "role" };
  if (request.riskLevel === "L3" && digestPhrase(phrase ?? "") !== request.typedPhraseDigest) {
    return { kind: "denied", reason: "phrase_mismatch" };
  }
  return this.store.confirmApproval({ ...request, principalId: actor.principalId, expiresAt: addMinutes(now, 15) });
}
```

Validation must recompute the operation digest from the current proposal digest, operation, command digest, diff SHA-256, and target environment; changes to project, branch, scope, diff, command, environment, prohibited effect, or acceptance command return `changed` and append an invalidation audit event. The generated L3 phrase is deterministic from the operation digest while only its digest is persisted.

- [ ] **Step 4: Verify channel/role matrix and replay protection**

Run: `pnpm test packages/core packages/persistence && pnpm typecheck`

Expected: Telegram always denies, expired or replayed approval cannot dispatch, and one approved digest authorizes only its recorded operation.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/persistence
git commit -m "feat(approvals): enforce digest-bound confirmation"
```

### Task 2: Tailscale identity and private API boundary

**Files:**
- Create: `packages/tailscale-adapter/package.json`
- Create: `packages/tailscale-adapter/src/identity.ts`
- Create: `packages/tailscale-adapter/src/session.ts`
- Create: `packages/tailscale-adapter/src/serve-diagnostics.ts`
- Create: `packages/tailscale-adapter/src/index.ts`
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/src/http.ts`
- Test: `packages/tailscale-adapter/test/identity.test.ts`
- Test: `apps/gateway/test/http-auth.test.ts`

**Interfaces:**
- Consumes: trusted reverse-proxy headers only from loopback/Tailscale Serve, principal bindings, and signed local session cookie.
- Produces: `resolveTailnetLogin(request)`, `startLocalSession(principal)`, `resolveTailnetPrincipal(request)`, authenticated Fastify request context, and Serve configuration diagnostics.

- [ ] **Step 1: Write spoofing and missing-session tests**

```ts
it("rejects a Tailscale header received from a non-loopback peer", () => {
  expect(resolveTailnetPrincipal(request({ remoteAddress: "192.0.2.10", login: "owner@example.com" }))).toEqual({ kind: "denied" });
});

it("requires both an allowlisted login and local session", async () => {
  const response = await app.inject({ method: "GET", url: "/api/commands", headers: trustedHeadersWithoutSession });
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: "unauthorized" });
});

it("issues an HttpOnly local session only for a trusted allowlisted tailnet login", async () => {
  const response = await app.inject({ method: "POST", url: "/auth/session", headers: trustedOwnerHeaders });
  expect(response.statusCode).toBe(204);
  expect(response.headers["set-cookie"]).toContain("HttpOnly");
  expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
});
```

- [ ] **Step 2: Run tests and confirm identity middleware is missing**

Run: `pnpm test packages/tailscale-adapter apps/gateway/test/http-auth.test.ts`

Expected: FAIL because private identity resolution is undefined.

- [ ] **Step 3: Implement trusted-proxy and session verification**

```ts
export function resolveTailnetPrincipal(input: IdentityInput): IdentityResult {
  if (!isTrustedServePeer(input.remoteAddress)) return { kind: "denied" };
  if (!input.session || !verifySession(input.session)) return { kind: "denied" };
  const identity = input.bindings.resolve("tailscale-web", input.loginName, input.session.principalId);
  if (identity.kind === "denied" || identity.principalId !== input.session.principalId) return { kind: "denied" };
  return identity;
}
```

`POST /auth/session` first validates the trusted Serve peer and allowlisted login without reading project data, then issues a short-lived Secure, HttpOnly, SameSite=Strict cookie signed with a Keychain-backed random key. Every protected request requires the same login binding to match the session principal. Diagnostics must fail when Serve is public, Funnel is enabled, upstream binding is not loopback, HTTPS is unavailable, or the advertised host is outside the expected tailnet. API errors expose no filesystem or project details before authentication.

- [ ] **Step 4: Verify trusted and spoofed request fixtures**

Run: `pnpm test packages/tailscale-adapter apps/gateway/test/http-auth.test.ts && pnpm typecheck`

Expected: only bound tailnet login plus valid local session reaches protected APIs.

- [ ] **Step 5: Commit**

```bash
git add packages/tailscale-adapter apps/gateway pnpm-lock.yaml
git commit -m "feat(tailscale): add private identity boundary"
```

### Task 3: Read and approval HTTP APIs

**Files:**
- Create: `apps/gateway/src/routes/commands.ts`
- Create: `apps/gateway/src/routes/projects.ts`
- Create: `apps/gateway/src/routes/approvals.ts`
- Create: `apps/gateway/src/routes/actions.ts`
- Modify: `apps/gateway/src/http.ts`
- Test: `apps/gateway/test/api.test.ts`

**Interfaces:**
- Consumes: authenticated principal, redacted query services, ApprovalService, execution stop/retry ports, and audit store.
- Produces: `/api/commands`, `/api/commands/:id`, `/api/projects`, `/api/approvals/:id/confirm`, `/api/actions/stop`, and `/api/actions/retry`.

- [ ] **Step 1: Write viewer/operator and immutable-confirmation tests**

```ts
it("allows a viewer to inspect but not approve", async () => {
  expect((await apiAs(viewer).get("/api/commands")).status).toBe(200);
  expect((await apiAs(viewer).post(`/api/approvals/${approval.id}/confirm`, {})).status).toBe(403);
});

it("returns conflict when the proposal digest changed", async () => {
  mutateProposalScope();
  const response = await apiAs(owner).post(`/api/approvals/${approval.id}/confirm`, { digest: approval.digest });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "proposal_changed" });
});
```

- [ ] **Step 2: Run API tests against absent routes**

Run: `pnpm test apps/gateway/test/api.test.ts`

Expected: FAIL with route-not-found responses.

- [ ] **Step 3: Implement Zod-validated routes and redacted views**

```ts
app.post("/api/approvals/:id/confirm", async (request, reply) => {
  const params = ApprovalParamsSchema.parse(request.params);
  const body = ApprovalConfirmationSchema.parse(request.body);
  const decision = approvals.confirmExisting(params.id, request.principal, body);
  if (decision.kind === "changed") return reply.code(409).send({ error: "proposal_changed" });
  if (decision.kind !== "approved") return reply.code(403).send({ error: decision.reason });
  return reply.code(200).send({ status: "approved", expiresAt: decision.expiresAt });
});
```

Every mutation requires CSRF protection, same-origin checks, audit event, and idempotency key. Stop requests stop dispatch only; worktree removal is a separate policy action.

- [ ] **Step 4: Verify authorization, validation, and audit coverage**

Run: `pnpm test apps/gateway && pnpm typecheck`

Expected: malformed data returns 400, unauthorized data returns 401/403 without metadata, and every accepted action creates one audit event.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(api): expose private control-plane routes"
```

### Task 4: Mobile Tailscale dashboard

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app.tsx`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/routes/command-list.tsx`
- Create: `apps/web/src/routes/command-detail.tsx`
- Create: `apps/web/src/components/approval-card.tsx`
- Create: `apps/web/src/styles.css`
- Test: `apps/web/src/app.test.tsx`
- Test: `apps/web/e2e/mobile-dashboard.spec.ts`

**Interfaces:**
- Consumes: authenticated gateway API and redacted command/route/task/dispatch/verification/delivery views.
- Produces: responsive PWA views for status, DAG, route evidence, approvals, typed L3 phrase, stop, and retry.

- [ ] **Step 1: Write component and mobile Playwright tests**

```ts
it("keeps verification and delivery status distinct", async () => {
  render(<CommandDetail command={verifiedButPendingDelivery} />);
  expect(screen.getByText("검증 완료")).toBeVisible();
  expect(screen.getByText("Slack 전송 대기")).toBeVisible();
});

test("L3 confirmation cannot submit without exact phrase", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/commands/c1");
  await expect(page.getByRole("button", { name: "승인" })).toBeDisabled();
  await page.getByLabel("확인 문구").fill("APPROVE DEPLOY C1");
  await expect(page.getByRole("button", { name: "승인" })).toBeEnabled();
});
```

- [ ] **Step 2: Run tests and confirm the app is absent**

Run: `pnpm test apps/web/src/app.test.tsx && pnpm --filter @orca-hq/web test:e2e`

Expected: FAIL because dashboard components and build do not exist.

- [ ] **Step 3: Implement focused routes and explicit risk UI**

```tsx
export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const [phrase, setPhrase] = useState("");
  const exact = approval.riskLevel !== "L3" || phrase === approval.operationPhrase;
  return <section aria-labelledby={`approval-${approval.id}`}>
    <h2 id={`approval-${approval.id}`}>{approval.riskLevel} 승인</h2>
    <ProposalDigestView approval={approval} />
    {approval.riskLevel === "L3" && <input aria-label="확인 문구" value={phrase} onChange={e => setPhrase(e.target.value)} />}
    <button disabled={!exact || approval.expired}>승인</button>
  </section>;
}
```

The command detail must show selected project and path, route score/evidence, base, allowed scope, prohibited effects, test commands, Task DAG, worker/verifier families, diff/test summaries, approvals, audit references, and pending channel delivery.

- [ ] **Step 4: Verify mobile accessibility and production build**

Run: `pnpm --filter @orca-hq/web test && pnpm --filter @orca-hq/web test:e2e && pnpm --filter @orca-hq/web build`

Expected: tests pass at 390×844 and 1280×800, keyboard focus is visible, and no secret/config value is embedded in assets.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add private mobile dashboard"
```

### Task 5: Gateway lifecycle composition and end-to-end state machine

**Files:**
- Modify: `apps/gateway/package.json`
- Create: `apps/gateway/src/config.ts`
- Create: `apps/gateway/src/lifecycle.ts`
- Create: `apps/gateway/src/main.ts`
- Modify: `apps/gateway/src/http.ts`
- Test: `apps/gateway/test/lifecycle.test.ts`
- Test: `apps/gateway/test/end-to-end.test.ts`

**Interfaces:**
- Consumes: every typed port from Plans 1–4, Keychain-backed config values, and process abort signals.
- Produces: one gateway process that starts migrations, adapters, HQ queue, execution supervisor, Outbox, HTTP API, and graceful shutdown in dependency order.

- [ ] **Step 1: Write startup-order and full lifecycle tests**

```ts
it("starts durable services before external adapters", async () => {
  await gateway.start();
  expect(events).toEqual(["config.valid", "db.migrated", "orca.checked", "reconciled", "http.started", "slack.started", "telegram.started"]);
});

it("takes an L1 command through verified completion", async () => {
  await fakeTelegram.send("샌드박스 프로젝트 테스트 수정해줘");
  await eventually(() => expect(query.commandByMessage("501")).toMatchObject({ state: "verified_success" }));
  expect(fakeOrca.dispatches).toHaveLength(2);
  expect(fakeTelegram.messages.at(-1)?.text).toContain("검증 완료");
});
```

- [ ] **Step 2: Run tests and confirm no composition root exists**

Run: `pnpm test apps/gateway/test/lifecycle.test.ts apps/gateway/test/end-to-end.test.ts`

Expected: FAIL because the gateway lifecycle is undefined.

- [ ] **Step 3: Compose dependency-injected services**

```ts
export async function createGateway(config: GatewayConfig, adapters: RuntimeAdapters): Promise<Gateway> {
  const db = openDatabase(config.databasePath);
  const store = new ControlStore(db);
  const orca = new OrcaClient(adapters.process, config.orca);
  const execution = new ExecutionService({ store, orca, locks: new WorktreeLockService(store), providers: adapters.workers });
  return new Gateway({ store, orca, execution, hq: adapters.hq, slack: adapters.slack, telegram: adapters.telegram, http: adapters.http });
}
```

Startup is fail-closed for invalid config, migration failure, Keychain denial, or incompatible Orca. Channel outage may start in degraded mode because durable reconciliation exists. Shutdown stops ingress, drains active transaction claims, checkpoints WAL, and preserves active Orca state for reconciliation.

- [ ] **Step 4: Verify the complete fake-channel flow**

Run: `pnpm test apps/gateway packages && pnpm typecheck && pnpm build`

Expected: L0/L1 proceeds according to policy, L2 waits for an exact approval, L3 requires phrase confirmation, failed verification blocks success, and all steps appear in audit.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway package.json pnpm-lock.yaml
git commit -m "feat(gateway): compose Orca HQ lifecycle"
```

## Plan 4 Completion Gate

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm --filter @orca-hq/web test:e2e`

Expected evidence:

- Slack and Tailscale approve only the exact unexpired digest.
- Telegram has no approval path for L2/L3.
- L3 requires an exact typed phrase.
- Private APIs reject spoofed Tailscale headers and unauthenticated sessions.
- The dashboard shows route, policy, worker, verifier, audit, and delivery evidence separately.
