import { randomBytes } from "node:crypto";

import { IdentityResolver, type AuthenticatedPrincipal, type PrincipalBinding } from "@orca-hq/core";
import { createLocalSessionService } from "@orca-hq/tailscale-adapter";
import { describe, expect, it } from "vitest";

import {
  createHttpApp,
  type ApprovalConfirmationPort,
  type CommandDashboardPort,
  type DispatchActionPort,
  type ProjectDashboardPort
} from "../src/http.js";

const digest = "a".repeat(64);
const origin = "https://hq.tailnet.example";

const owner = binding("owner", ["owner"]);
const operator = binding("operator", ["operator"]);
const viewer = binding("viewer", ["viewer"]);

function binding(principalId: string, roles: readonly ("owner" | "operator" | "viewer")[]): PrincipalBinding {
  return {
    principalId,
    slackUserIds: [],
    telegramUserIds: [],
    telegramChatIds: [],
    tailscaleLoginNames: [`${principalId}@example.test`],
    roles: [...roles]
  };
}

function noRoleBinding(): PrincipalBinding {
  return { ...binding("empty", []), roles: [] };
}

type RecordedCall = Readonly<{ type: "approval" | "stop" | "retry"; idempotencyKey: string }>;

function createPorts() {
  const calls: RecordedCall[] = [];
  const commands: CommandDashboardPort = {
    async listCommands() {
      return { commands: [{ commandId: "command-1", status: "pending", projectKey: "project-a" }] };
    },
    async getCommand({ commandId }) {
      return commandId === "command-1"
        ? { commandId, status: "pending", projectKey: "project-a" }
        : undefined;
    }
  };
  const projects: ProjectDashboardPort = {
    async listProjects() {
      return { projects: [{ projectKey: "project-a", status: "active" }] };
    }
  };
  const approvals: ApprovalConfirmationPort = {
    async confirmExisting(input) {
      if (input.digest !== digest) return { kind: "changed" };
      if (input.principal.roles.includes("operator") && input.approvalId === "l3-approval") {
        return { kind: "denied" };
      }
      if (input.approvalId === "l3-approval" && input.phrase !== "APPROVE L3") return { kind: "denied" };
      calls.push({ type: "approval", idempotencyKey: input.idempotencyKey });
      return { kind: "approved", expiresAt: "2026-09-03T12:00:00.000Z" };
    }
  };
  const actions: DispatchActionPort = {
    async stop(input) {
      calls.push({ type: "stop", idempotencyKey: input.idempotencyKey });
      return { kind: "stopped" };
    },
    async retry(input) {
      calls.push({ type: "retry", idempotencyKey: input.idempotencyKey });
      return { kind: "retried" };
    }
  };
  return { commands, projects, approvals, actions, calls };
}

function createApp(
  bindings: readonly PrincipalBinding[] = [owner, operator, viewer],
  allowedOrigin = origin
) {
  const ports = createPorts();
  const app = createHttpApp({
    bindings,
    resolver: new IdentityResolver({ bindings, allowedSlackWorkspaceIds: ["T123"] }),
    sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(7) }),
    peerAddress: () => "127.0.0.1",
    allowedOrigin,
    ...ports
  });
  return { app, ...ports };
}

async function apiAs(app: ReturnType<typeof createHttpApp>, principal: PrincipalBinding) {
  const login = await app.inject({
    method: "POST",
    url: "/auth/session",
    headers: { "tailscale-user-login": principal.tailscaleLoginNames[0]! }
  });
  const cookie = login.headers["set-cookie"]?.split(";")[0];
  const csrfToken = login.headers["x-csrf-token"];
  if (cookie === undefined || typeof csrfToken !== "string") throw new Error("test session bootstrap failed");
  return {
    get(url: string) {
      return app.inject({ method: "GET", url, headers: {
        "tailscale-user-login": principal.tailscaleLoginNames[0]!, cookie
      } });
    },
    post(url: string, body: unknown, headers: Record<string, string> = {}) {
      return app.inject({ method: "POST", url, payload: body, headers: {
        "tailscale-user-login": principal.tailscaleLoginNames[0]!, cookie,
        origin,
        "x-csrf-token": csrfToken,
        "idempotency-key": randomBytes(16).toString("hex"),
        ...headers
      } });
    }
  };
}

describe("gateway dashboard API", () => {
  it("allows a viewer to inspect but not approve", async () => {
    // Break caught: a read-only viewer can cause approval side effects.
    const { app, calls } = createApp();
    try {
      const viewerApi = await apiAs(app, viewer);
      expect((await viewerApi.get("/api/commands")).statusCode).toBe(200);
      expect((await viewerApi.post("/api/approvals/approval-1/confirm", { digest })).statusCode).toBe(403);
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("returns conflict when the proposal digest changed", async () => {
    // Break caught: confirmation accepts a digest that differs from the server's restored proposal.
    const { app, calls } = createApp();
    try {
      const ownerApi = await apiAs(app, owner);
      const response = await ownerApi.post("/api/approvals/approval-1/confirm", { digest: "b".repeat(64) });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "proposal_changed" });
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("serves only redacted dashboard views and preserves command detail not-found", async () => {
    // Break caught: dashboard routes expose raw records or turn a missing command into a success response.
    const { app } = createApp();
    try {
      const ownerApi = await apiAs(app, owner);
      expect((await ownerApi.get("/api/commands")).json()).toEqual({
        commands: [{ commandId: "command-1", status: "pending", projectKey: "project-a" }]
      });
      expect((await ownerApi.get("/api/commands/command-1")).statusCode).toBe(200);
      const missing = await ownerApi.get("/api/commands/missing");
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "not_found" });
      expect((await ownerApi.get("/api/projects")).json()).toEqual({
        projects: [{ projectKey: "project-a", status: "active" }]
      });
    } finally {
      await app.close();
    }
  });

  it("enforces the owner operator viewer mutation role matrix including L3 phrase", async () => {
    // Break caught: mutation authorization ignores role or permits an operator to complete L3 confirmation.
    const { app, calls } = createApp();
    try {
      const ownerApi = await apiAs(app, owner);
      const operatorApi = await apiAs(app, operator);
      const viewerApi = await apiAs(app, viewer);
      expect((await ownerApi.post("/api/approvals/l3-approval/confirm", { digest, phrase: "APPROVE L3" })).statusCode).toBe(200);
      expect((await operatorApi.post("/api/approvals/approval-1/confirm", { digest })).statusCode).toBe(200);
      expect((await operatorApi.post("/api/approvals/l3-approval/confirm", { digest, phrase: "APPROVE L3" })).statusCode).toBe(403);
      expect((await viewerApi.post("/api/actions/stop", { dispatchId: "dispatch-1" })).statusCode).toBe(403);
      expect((await ownerApi.post("/api/approvals/l3-approval/confirm", { digest })).statusCode).toBe(403);
      expect(calls.map(({ type }) => type)).toEqual(["approval", "approval"]);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown or empty roles before dashboard ports run", async () => {
    // Break caught: an unrecognized principal role falls through to protected query work.
    const { app, commands } = createApp([noRoleBinding()]);
    let calls = 0;
    const original = commands.listCommands;
    commands.listCommands = async (principal) => {
      calls += 1;
      return original(principal);
    };
    try {
      const emptyApi = await apiAs(app, noRoleBinding());
      const response = await emptyApi.get("/api/commands");
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
      expect(calls).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("requires exact origin csrf and a single non-empty idempotency key before mutations", async () => {
    // Break caught: a cross-origin or replayable browser request reaches a control-plane mutation.
    const { app, calls } = createApp();
    try {
      const ownerApi = await apiAs(app, owner);
      for (const headers of [
        { origin: "https://other.tailnet.example" },
        { "x-csrf-token": "wrong" },
        { "idempotency-key": "" },
        { "idempotency-key": "one,two" }
      ]) {
        const response = await ownerApi.post("/api/actions/stop", { dispatchId: "dispatch-1" }, headers);
        const expectedStatus = "idempotency-key" in headers ? 400 : 403;
        expect(response.statusCode).toBe(expectedStatus);
        expect(response.json()).toEqual({ error: expectedStatus === 400 ? "bad_request" : "forbidden" });
      }
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the configured mutation origin is not HTTPS", async () => {
    // Break caught: an HTTP dashboard origin can submit an otherwise valid authenticated mutation.
    const insecureOrigin = "http://hq.tailnet.example";
    const { app, calls } = createApp([owner], insecureOrigin);
    try {
      const ownerApi = await apiAs(app, owner);
      const response = await ownerApi.post("/api/actions/stop", { dispatchId: "dispatch-1" }, {
        origin: insecureOrigin
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("returns generic bad-request responses for strict params bodies and headers", async () => {
    // Break caught: malformed route input becomes an internal error or permits extra client-controlled fields.
    const { app, calls } = createApp();
    try {
      const ownerApi = await apiAs(app, owner);
      for (const [url, body, headers] of [
        ["/api/approvals/%20/confirm", { digest }, {}],
        ["/api/approvals/approval-1/confirm", { digest, proposal: { unsafe: true } }, {}],
        ["/api/actions/retry", { dispatchId: "dispatch-1", command: "rm -rf" }, {}],
        ["/api/actions/stop", { dispatchId: "" }, {}]
      ] as const) {
        const response = await ownerApi.post(url, body, headers);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "bad_request" });
      }
      expect(calls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("delegates duplicate action keys once so the mutation port owns atomic idempotency and audit", async () => {
    // Break caught: the HTTP route adds a second side effect or audit entry on an idempotent replay.
    const { app, actions } = createApp();
    const seen = new Set<string>();
    let sideEffects = 0;
    let auditEvents = 0;
    actions.stop = async ({ idempotencyKey }) => {
      if (!seen.has(idempotencyKey)) {
        seen.add(idempotencyKey);
        sideEffects += 1;
        auditEvents += 1;
      }
      return { kind: "stopped" };
    };
    try {
      const ownerApi = await apiAs(app, owner);
      const headers = { "idempotency-key": "same-key" };
      expect((await ownerApi.post("/api/actions/stop", { dispatchId: "dispatch-1" }, headers)).statusCode).toBe(200);
      expect((await ownerApi.post("/api/actions/stop", { dispatchId: "dispatch-1" }, headers)).statusCode).toBe(200);
      expect({ sideEffects, auditEvents }).toEqual({ sideEffects: 1, auditEvents: 1 });
    } finally {
      await app.close();
    }
  });

  it("stops and retries only stored dispatch identifiers without cleanup inputs", async () => {
    // Break caught: action routes accept worktree or command injection fields alongside the dispatch identifier.
    const { app, calls } = createApp();
    try {
      const operatorApi = await apiAs(app, operator);
      const stop = await operatorApi.post("/api/actions/stop", { dispatchId: "dispatch-1" });
      const retry = await operatorApi.post("/api/actions/retry", { dispatchId: "dispatch-1" });
      expect(stop.json()).toEqual({ status: "stopped" });
      expect(retry.json()).toEqual({ status: "retried" });
      expect(calls.map(({ type }) => type)).toEqual(["stop", "retry"]);
    } finally {
      await app.close();
    }
  });
});
