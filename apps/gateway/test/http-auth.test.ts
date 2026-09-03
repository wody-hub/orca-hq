import { describe, expect, it, vi } from "vitest";

import { IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import { createLocalSessionService, type LocalSessionService } from "@orca-hq/tailscale-adapter";
import { createHttpApp } from "../src/http.js";

const owner = {
  principalId: "owner",
  slackUserIds: [],
  telegramUserIds: [],
  telegramChatIds: [],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

const createApp = (options: {
  peerAddress?: string;
  onCommands?: (principal: { principalId: string }) => unknown;
} = {}) => {
  const resolver = new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] });
  return createHttpApp({
    bindings: [owner],
    resolver,
    sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(7) }),
    peerAddress: () => options.peerAddress ?? "127.0.0.1",
    ...(options.onCommands === undefined ? {} : { onCommands: options.onCommands })
  });
};

const trustedHeaders = { "tailscale-user-login": "owner@example.test" };

describe("gateway HTTP authentication boundary", () => {
  it("serves configured static assets and SPA routes without swallowing API or auth misses", async () => {
    // Break caught: a dashboard deep link 404s, or an unknown protected route is masked by index.html.
    const app = createHttpApp({
      bindings: [owner],
      resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
      sessions: createLocalSessionService({ signingKey: new Uint8Array(32).fill(7) }),
      peerAddress: () => "127.0.0.1",
      webAssets: {
        async asset(path) {
          return path === "/assets/app.js"
            ? { contentType: "text/javascript", body: "console.log('safe')" }
            : undefined;
        },
        async indexHtml() {
          return "<!doctype html><div id=\"root\"></div>";
        }
      }
    });
    try {
      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/javascript");
      expect(asset.body).toContain("console.log");
      expect((await app.inject({ method: "GET", url: "/commands/command-1" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/auth/missing" })).statusCode).toBe(404);
      for (const url of ["/api%2Fmissing", "/auth%2Fmissing", "/API/missing"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: "not_found" });
      }
      const malformed = await app.inject({ method: "GET", url: "/api%ZZmissing" });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.headers["content-type"]).toContain("application/json");
    } finally {
      await app.close();
    }
  });

  it("returns only unauthorized without calling protected work when the session is absent", async () => {
    // Break caught: an unauthenticated request reads command metadata before the session boundary.
    const onCommands = vi.fn();
    const app = createApp({ onCommands });
    try {
      const response = await app.inject({ method: "GET", url: "/api/commands", headers: trustedHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(onCommands).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("issues a secure local session only for a trusted allowlisted login", async () => {
    // Break caught: a direct client can obtain an authenticated local cookie by setting a Tailscale header.
    const app = createApp();
    try {
      const response = await app.inject({ method: "POST", url: "/auth/session", headers: trustedHeaders });
      expect(response.statusCode).toBe(204);
      expect(response.headers["set-cookie"]).toContain("__Host-orca_hq_session=");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    } finally {
      await app.close();
    }
  });

  it("rejects spoofed headers from a non-loopback peer", async () => {
    // Break caught: an untrusted peer can impersonate a tailnet login through a request header.
    const app = createApp({ peerAddress: "192.0.2.10" });
    try {
      const response = await app.inject({ method: "POST", url: "/auth/session", headers: trustedHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    } finally {
      await app.close();
    }
  });

  it("returns a generic internal error when session issuance throws before authentication", async () => {
    // Break caught: an unauthenticated caller receives session-service secrets from Fastify's default error response.
    const sessions = {
      startLocalSession() {
        throw new Error("secret detail: /Users/example/private");
      },
      verify() {
        return { kind: "denied" as const };
      }
    } satisfies LocalSessionService;
    const app = createHttpApp({
      bindings: [owner],
      resolver: new IdentityResolver({ bindings: [owner], allowedSlackWorkspaceIds: ["T123"] }),
      sessions,
      peerAddress: () => "127.0.0.1"
    });
    try {
      const response = await app.inject({ method: "POST", url: "/auth/session", headers: trustedHeaders });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "internal_error" });
      expect(response.body).not.toContain("secret");
      expect(response.body).not.toContain("/Users");
      expect(response.body).not.toContain("private");
    } finally {
      await app.close();
    }
  });

  it("denies an invalid principal binding without starting a session", async () => {
    // Break caught: an invalid binding reaches session issuance and leaks an internal validation error.
    const invalidOwner = { ...owner, principalId: " owner " } satisfies PrincipalBinding;
    const startLocalSession = vi.fn(() => {
      throw new Error("session issuance must not be attempted");
    });
    const sessions = {
      startLocalSession,
      verify() {
        return { kind: "denied" as const };
      }
    } satisfies LocalSessionService;
    const app = createHttpApp({
      bindings: [invalidOwner],
      resolver: new IdentityResolver({ bindings: [invalidOwner], allowedSlackWorkspaceIds: ["T123"] }),
      sessions,
      peerAddress: () => "127.0.0.1"
    });
    try {
      const response = await app.inject({ method: "POST", url: "/auth/session", headers: trustedHeaders });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(startLocalSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a generic not-found response before authentication", async () => {
    // Break caught: an unauthenticated caller learns Fastify's route candidate for an unregistered endpoint.
    const app = createApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/private-projects" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
      expect(response.body).not.toContain("Route GET");
      expect(response.body).not.toContain("private-projects");
    } finally {
      await app.close();
    }
  });

  it("returns only unauthorized without calling protected work for a tampered session", async () => {
    // Break caught: a forged cookie reaches the command query despite failing local-session verification.
    const onCommands = vi.fn();
    const app = createApp({ onCommands });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/commands",
        headers: { ...trustedHeaders, cookie: "__Host-orca_hq_session=forged" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
      expect(onCommands).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("calls protected work only after the current login and cookie agree", async () => {
    // Break caught: an old or mismatched session can invoke the protected command query.
    const onCommands = vi.fn((principal: { principalId: string }) => ({
      principalId: principal.principalId,
      commands: []
    }));
    const app = createApp({ onCommands });
    try {
      const issued = await app.inject({ method: "POST", url: "/auth/session", headers: trustedHeaders });
      const setCookie = issued.headers["set-cookie"];
      const sessionCookie = typeof setCookie === "string" ? setCookie.split(";")[0] : undefined;
      const response = await app.inject({
        method: "GET",
        url: "/api/commands",
        headers: { ...trustedHeaders, cookie: sessionCookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ principalId: "owner", commands: [] });
      expect(onCommands).toHaveBeenCalledWith(expect.objectContaining({ principalId: "owner" }));
    } finally {
      await app.close();
    }
  });
});
