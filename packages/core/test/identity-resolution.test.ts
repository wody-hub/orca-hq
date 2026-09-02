import { describe, expect, it } from "vitest";

import {
  deriveIdempotencyKey,
  IdentityResolver,
  type CommandEnvelope,
  type PrincipalBinding
} from "../src/index.js";
import { ControlStore, openDatabase } from "@orca-hq/persistence";

const owner = {
  principalId: "owner",
  slackUserIds: ["U123"],
  telegramUserIds: ["7788"],
  telegramChatIds: ["9900"],
  tailscaleLoginNames: ["owner@example.test"],
  roles: ["owner"]
} satisfies PrincipalBinding;

const resolver = new IdentityResolver({
  bindings: [owner],
  allowedSlackWorkspaceIds: ["T123"]
});

describe("IdentityResolver", () => {
  it("rejects configuration with more than one trusted Slack workspace", () => {
    // Break caught: a workspace-wide user binding becomes ambiguous when multiple Slack teams are trusted.
    expect(() => new IdentityResolver({
      bindings: [owner],
      allowedSlackWorkspaceIds: ["T123", "T999"]
    })).toThrow("exactly one trusted Slack workspace");
  });

  it("maps the owner's Slack and Telegram identities to one principal", () => {
    expect(resolver.resolve("slack", "U123", "T123")).toMatchObject({
      principalId: "owner",
      roles: ["owner"]
    });
    expect(resolver.resolve("telegram", "7788", "9900")).toMatchObject({
      principalId: "owner"
    });
  });

  it("denies a Telegram identity outside its allowlisted chat without metadata", () => {
    expect(resolver.resolve("telegram", "7788", "unapproved-chat")).toEqual({ kind: "denied" });
  });

  it("denies a Slack identity outside the trusted workspace", () => {
    expect(resolver.resolve("slack", "U123", "unapproved-workspace")).toEqual({ kind: "denied" });
  });

  it("requires a Tailscale login to match its local-session principal", () => {
    expect(resolver.resolve("tailscale-web", "owner@example.test", "owner")).toMatchObject({
      principalId: "owner"
    });
    expect(resolver.resolve("tailscale-web", "owner@example.test", "other-principal"))
      .toEqual({ kind: "denied" });
  });

  it("reveals no metadata to an unknown identity", () => {
    expect(resolver.resolve("telegram", "unknown", "9900")).toEqual({ kind: "denied" });
  });
});

describe("deriveIdempotencyKey", () => {
  it("derives the same idempotency key for a redelivered provider message", () => {
    expect(deriveIdempotencyKey("slack:T123", "171.001")).toBe(
      "162c762505e6e831047a9e01a6f275e720b3fd6ed0a2fdd1c7abffc6ccc06e86"
    );
    expect(deriveIdempotencyKey("slack:T123", "171.001")).toBe(
      deriveIdempotencyKey("slack:T123", "171.001")
    );
  });
});

describe("CommandIngress", () => {
  it("accepts a provider message once and reports its redelivery as duplicate", async () => {
    const database = openDatabase(":memory:");
    const ingress = new ControlStore(database);
    const command = {
      commandId: "cmd-1",
      idempotencyKey: deriveIdempotencyKey("slack:T123", "171.001"),
      channel: "slack",
      externalMessageId: "171.001",
      principalId: "owner",
      receivedAt: "2026-09-01T00:00:00.000Z",
      text: "status"
    } satisfies CommandEnvelope;

    try {
      await expect(ingress.accept(command)).resolves.toEqual({
        kind: "accepted",
        commandId: "cmd-1"
      });
      await expect(ingress.accept({ ...command, commandId: "cmd-redelivered" })).resolves.toEqual({
        kind: "duplicate",
        commandId: "cmd-1"
      });
      expect(ingress.listInboxEvents()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
