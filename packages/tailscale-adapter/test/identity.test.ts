import { describe, expect, it } from "vitest";

import { IdentityResolver, type PrincipalBinding } from "@orca-hq/core";
import {
  createLocalSessionService,
  diagnoseServeConfiguration,
  resolveTailnetLogin,
  resolveTailnetPrincipal
} from "../src/index.js";

const owner = {
  principalId: "owner",
  slackUserIds: [],
  telegramUserIds: [],
  telegramChatIds: [],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

const duplicateLogin = {
  ...owner,
  principalId: "duplicate",
  roles: ["viewer"]
} satisfies PrincipalBinding;

const resolver = new IdentityResolver({
  bindings: [owner],
  allowedSlackWorkspaceIds: ["T123"]
});

const signingKey = new Uint8Array(32).fill(7);
const now = new Date("2026-09-01T00:00:00.000Z");
const localRequest = (login: string | readonly string[] | undefined) => ({
  remoteAddress: "127.0.0.1",
  headers: login === undefined ? {} : { "tailscale-user-login": login }
});

describe("Tailscale Serve identity", () => {
  it("denies a Tailscale header from every non-loopback peer", () => {
    // Break caught: a direct or private-network client can spoof a trusted proxy identity header.
    for (const remoteAddress of ["192.0.2.10", "100.64.0.1", "10.0.0.5", "::ffff:192.0.2.10"]) {
      expect(resolveTailnetLogin({ ...localRequest("owner@example.test"), remoteAddress }, [owner]))
        .toEqual({ kind: "denied" });
    }
  });

  it("accepts only a singular allowlisted login from loopback", () => {
    // Break caught: ambiguous, missing, or unregistered proxy headers receive a local session.
    expect(resolveTailnetLogin(localRequest("owner@example.test"), [owner])).toMatchObject({
      principalId: "owner",
      loginName: "owner@example.test"
    });
    expect(resolveTailnetLogin(localRequest(undefined), [owner])).toEqual({ kind: "denied" });
    expect(resolveTailnetLogin(localRequest(""), [owner])).toEqual({ kind: "denied" });
    expect(resolveTailnetLogin(localRequest("owner@example.test, attacker@example.test"), [owner]))
      .toEqual({ kind: "denied" });
    expect(resolveTailnetLogin(localRequest(["owner@example.test", "attacker@example.test"]), [owner]))
      .toEqual({ kind: "denied" });
    expect(resolveTailnetLogin({
      ...localRequest("owner@example.test"),
      headers: {
        "tailscale-user-login": "owner@example.test",
        "Tailscale-User-Login": "owner@example.test"
      }
    }, [owner])).toEqual({ kind: "denied" });
    expect(resolveTailnetLogin(localRequest("unknown@example.test"), [owner])).toEqual({ kind: "denied" });
    expect(resolveTailnetLogin(localRequest("owner@example.test"), [owner, duplicateLogin]))
      .toEqual({ kind: "denied" });
  });
});

describe("signed local sessions", () => {
  it("issues the required host-only cookie for exactly fifteen minutes", () => {
    // Break caught: browsers can send the session outside HTTPS, outside this host, or after its approval boundary.
    const sessions = createLocalSessionService({ signingKey, now: () => now, nonce: () => "nonce" });
    const issued = sessions.startLocalSession({ principalId: "owner", loginName: "owner@example.test" });

    expect(issued.expiresAt).toBe("2026-09-01T00:15:00.000Z");
    expect(issued.cookie).toContain("__Host-orca_hq_session=");
    expect(issued.cookie).toContain("Max-Age=900");
    expect(issued.cookie).toContain("Path=/");
    expect(issued.cookie).toContain("Secure");
    expect(issued.cookie).toContain("HttpOnly");
    expect(issued.cookie).toContain("SameSite=Strict");
    expect(issued.cookie).not.toContain("Domain=");
  });

  it("rejects tampered, expired, future-issued, and swapped sessions", () => {
    // Break caught: a stolen, forged, or temporally invalid cookie authenticates a different tailnet identity.
    const sessions = createLocalSessionService({ signingKey, now: () => now, nonce: () => "nonce" });
    const token = sessions.startLocalSession({ principalId: "owner", loginName: "owner@example.test" }).token;
    expect(sessions.verify(token, { principalId: "owner", loginName: "owner@example.test" }))
      .toMatchObject({ principalId: "owner" });
    expect(sessions.verify(`${token}x`, { principalId: "owner", loginName: "owner@example.test" }))
      .toEqual({ kind: "denied" });
    expect(sessions.verify("not-a-session", { principalId: "owner", loginName: "owner@example.test" }))
      .toEqual({ kind: "denied" });
    expect(sessions.verify(token, { principalId: "other", loginName: "owner@example.test" }))
      .toEqual({ kind: "denied" });
    expect(sessions.verify(token, { principalId: "owner", loginName: "other@example.test" }))
      .toEqual({ kind: "denied" });

    const expired = createLocalSessionService({
      signingKey,
      now: () => new Date("2026-09-01T00:15:00.001Z"),
      nonce: () => "nonce"
    });
    expect(expired.verify(token, { principalId: "owner", loginName: "owner@example.test" }))
      .toEqual({ kind: "denied" });
    const future = createLocalSessionService({
      signingKey,
      now: () => new Date("2026-08-31T23:59:59.999Z"),
      nonce: () => "nonce"
    });
    expect(future.verify(token, { principalId: "owner", loginName: "owner@example.test" }))
      .toEqual({ kind: "denied" });
  });

  it("requires a 32-byte signing key", () => {
    // Break caught: low-entropy signing material is accepted for an authentication cookie.
    expect(() => createLocalSessionService({ signingKey: new Uint8Array(31) })).toThrow("32 bytes");
  });
});

describe("protected principal resolution", () => {
  it("requires the current trusted login, session, and binding to agree", () => {
    // Break caught: a valid session alone reaches a protected API after the Tailscale login changed.
    const sessions = createLocalSessionService({ signingKey, now: () => now, nonce: () => "nonce" });
    const session = sessions.startLocalSession({ principalId: "owner", loginName: "owner@example.test" }).token;
    expect(resolveTailnetPrincipal({
      ...localRequest("owner@example.test"), session, bindings: [owner], resolver, sessions
    })).toMatchObject({ principalId: "owner", roles: ["owner"] });
    expect(resolveTailnetPrincipal({
      ...localRequest("other@example.test"), session, bindings: [owner], resolver, sessions
    })).toEqual({ kind: "denied" });
  });
});

describe("Serve diagnostics", () => {
  const valid = {
    funnelEnabled: false,
    publicExposure: false,
    gatewayBindAddress: "127.0.0.1",
    upstreamAddress: "[::1]:4310",
    httpsEnabled: true,
    advertisedHost: "hq.example.ts.net",
    expectedTailnetDnsSuffix: "example.ts.net"
  };

  it("rejects public, insecure, non-loopback, and suffix-spoofed Serve configurations", () => {
    // Break caught: a non-tailnet or public path exposes dashboard metadata.
    expect(diagnoseServeConfiguration({ ...valid, funnelEnabled: true }).kind).toBe("invalid");
    expect(diagnoseServeConfiguration({ ...valid, publicExposure: true }).kind).toBe("invalid");
    expect(diagnoseServeConfiguration({ ...valid, gatewayBindAddress: "0.0.0.0" }).kind).toBe("invalid");
    expect(diagnoseServeConfiguration({ ...valid, upstreamAddress: "100.64.0.4:4310" }).kind).toBe("invalid");
    expect(diagnoseServeConfiguration({ ...valid, httpsEnabled: false }).kind).toBe("invalid");
    expect(diagnoseServeConfiguration({ ...valid, advertisedHost: "evil-example.ts.net" }).kind).toBe("invalid");
  });

  it("accepts only a private HTTPS Serve configuration on the expected tailnet suffix", () => {
    // Break caught: a valid tailnet-only configuration is unnecessarily rejected.
    expect(diagnoseServeConfiguration(valid)).toEqual({ kind: "valid" });
  });
});
