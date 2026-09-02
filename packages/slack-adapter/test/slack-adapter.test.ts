import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IdentityResolver, type CommandEnvelope, type CommandIngress } from "@orca-hq/core";
import { ControlStore, openDatabase } from "@orca-hq/persistence";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSlackAdapter,
  createSlackAttachmentStager,
  deliverSlackMessage,
  registerSlackSocketModeHandlers,
  SlackAttachmentTooLargeError,
  writeFully
} from "../src/index.js";
import slackFileShareFixture from "./fixtures/file-share-message.json" with { type: "json" };
import slackMessageFixture from "./fixtures/message.json" with { type: "json" };

const identities = new IdentityResolver({
  bindings: [{
    principalId: "owner",
    slackUserIds: ["U123"],
    telegramUserIds: [],
    telegramChatIds: [],
    tailscaleLoginNames: [],
    roles: ["owner"]
  }],
  allowedSlackWorkspaceIds: ["T123"]
});

const stagedDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(stagedDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

function acceptedIngress(): CommandIngress & { accept: ReturnType<typeof vi.fn> } {
  return {
    accept: vi.fn(async (command: CommandEnvelope) => ({
      kind: "accepted" as const,
      commandId: command.commandId
    }))
  };
}

async function stagingDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orca-slack-test-"));
  stagedDirectories.push(directory);
  return directory;
}

function unusedStagingDirectory(): string {
  const directory = join(tmpdir(), `orca-slack-unused-test-${randomUUID()}`);
  stagedDirectories.push(directory);
  return directory;
}

async function stagedFileNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

async function stagedFilePaths(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function adapterFor(options: {
  ingress?: CommandIngress & { accept: ReturnType<typeof vi.fn> };
  cursorStore?: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  history?: { listMessages: ReturnType<typeof vi.fn> };
  files?: { download: ReturnType<typeof vi.fn> };
  interactiveActionsEnabled?: boolean;
  approvalRequests?: { accept: ReturnType<typeof vi.fn> };
} = {}) {
  const ingress = options.ingress ?? acceptedIngress();
  const cursorStore = options.cursorStore ?? {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined)
  };
  const history = options.history ?? {
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined }))
  };
  const files = options.files ?? {
    download: vi.fn(async function* () { yield new Uint8Array(); })
  };

  return {
    adapter: createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory(),
      ...(options.interactiveActionsEnabled === undefined
        ? {}
        : { interactiveActionsEnabled: options.interactiveActionsEnabled })
    }, {
      ingress,
      identities,
      cursorStore,
      history,
      files,
      ...(options.approvalRequests === undefined
        ? {}
        : { approvalRequests: options.approvalRequests })
    }),
    ingress,
    cursorStore,
    history
  };
}

describe("Slack adapter", () => {
  it("requires a durable approval-request port when interactive actions are enabled", () => {
    // Break caught: an enabled action handler with optional persistence can acknowledge and discard approvals.
    expect(() => createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory(),
      interactiveActionsEnabled: true
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array(); }) }
    })).toThrow("durable approval-request port");
  });

  it("normalizes one channel message and keeps its thread", async () => {
    // Break caught: using only thread_ts would lose the root-thread association.
    const { adapter, ingress } = adapterFor();

    await adapter.handleEvent(slackMessageFixture);

    expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
      channel: "slack",
      externalMessageId: "171.001",
      externalThreadId: "171.001",
      principalId: "owner",
      text: "status"
    }));
  });

  it("accepts a validated Slack file_share message through the production adapter", async () => {
    // Break caught: rejecting every message subtype discards real user file uploads before staging.
    const directory = await stagingDirectory();
    const ingress = acceptedIngress();
    const fileBytes = new TextEncoder().encode("requirements");
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield fileBytes; }) }
    });

    await adapter.handleEvent(slackFileShareFixture, "T123");

    expect(ingress.accept).toHaveBeenCalledWith(expect.objectContaining({
      externalMessageId: "171.003",
      text: "Review the attached requirements",
      attachments: [expect.objectContaining({
        providerFileId: "F123",
        name: "requirements.pdf"
      })]
    }));
    expect(JSON.stringify(ingress.accept.mock.calls)).not.toContain("https://files.slack.com/");
  });

  it("rejects a bot-authored Slack file_share even when it carries a user field", async () => {
    // Break caught: subtype=file_share alone is insufficient to distinguish a human upload from a bot event.
    const ingress = acceptedIngress();
    const files = { download: vi.fn(async function* () { yield new Uint8Array([1]); }) };
    const { adapter } = adapterFor({ ingress, files });

    await adapter.handleEvent({
      ...slackFileShareFixture,
      bot_id: "B123",
      bot_profile: { id: "B123", name: "automation" }
    }, "T123");

    expect(files.download).not.toHaveBeenCalled();
    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it.each([
    "bot_message",
    "message_changed",
    "message_deleted",
    "channel_join",
    "thread_broadcast"
  ])("rejects the Slack %s subtype", async (subtype) => {
    // Break caught: widening subtype acceptance beyond validated file_share admits bot/system/mutation events.
    const { adapter, ingress } = adapterFor();

    await adapter.handleEvent({ ...slackMessageFixture, subtype }, "T123");

    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it("registers Socket Mode message and interactive-action handlers", async () => {
    // Break caught: registering an action handler without a Bolt action constraint leaves approvals undeliverable.
    const ingress = acceptedIngress();
    const approvalAccept = vi.fn(async () => ({
      kind: "accepted" as const,
      requestId: "approval-request-1"
    }));
    const { adapter } = adapterFor({
      ingress,
      interactiveActionsEnabled: true,
      approvalRequests: { accept: approvalAccept }
    });
    const app = {
      event: vi.fn(),
      action: vi.fn()
    };

    registerSlackSocketModeHandlers(app, adapter);

    expect(app.event).toHaveBeenCalledWith("message", expect.any(Function));
    expect(app.action).toHaveBeenCalledWith(/.*/, expect.any(Function));
    const messageHandler = app.event.mock.calls[0]?.[1] as (payload: {
      event: unknown;
      body: unknown;
    }) => Promise<void>;
    await messageHandler({ event: slackMessageFixture, body: { team_id: "T123" } });
    expect(ingress.accept).toHaveBeenCalledTimes(1);
    const actionHandler = app.action.mock.calls[0]?.[1] as (payload: {
      body: unknown;
      ack: () => Promise<void>;
    }) => Promise<void>;
    const ack = vi.fn(async () => undefined);
    await actionHandler({
      ack,
      body: {
        team: { id: "T123" },
        user: { id: "U123" },
        channel: { id: "C123" },
        container: { message_ts: "171.001" },
        actions: [{ action_id: "approve", action_ts: "171.001100", value: "proposal-1" }]
      }
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(approvalAccept.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]!);
  });

  it("does not acknowledge an interactive action when durable persistence fails", async () => {
    // Break caught: acknowledging before durable acceptance loses the request and prevents Slack retry.
    const accept = vi.fn(async () => { throw new Error("approval request store unavailable"); });
    const { adapter } = adapterFor({
      interactiveActionsEnabled: true,
      approvalRequests: { accept }
    });
    const app = { event: vi.fn(), action: vi.fn() };
    registerSlackSocketModeHandlers(app, adapter);
    const actionHandler = app.action.mock.calls[0]?.[1] as (payload: {
      body: unknown;
      ack: () => Promise<void>;
    }) => Promise<void>;
    const ack = vi.fn(async () => undefined);

    await expect(actionHandler({
      ack,
      body: {
        team: { id: "T123" },
        user: { id: "U123" },
        channel: { id: "C123" },
        container: { message_ts: "171.001" },
        actions: [{ action_id: "approve", action_ts: "171.001100", value: "proposal-1" }]
      }
    })).rejects.toThrow("approval request store unavailable");

    expect(accept).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
  });

  it("advances the history cursor only after ingress stores the event", async () => {
    // Break caught: saving a cursor before durable ingress loses a command after a failure.
    const ingress = acceptedIngress();
    ingress.accept.mockRejectedValueOnce(new Error("disk unavailable"));
    const cursorStore = {
      load: vi.fn(async () => "170.999"),
      save: vi.fn(async () => undefined)
    };
    const history = {
      listMessages: vi.fn(async () => ({
        messages: [slackMessageFixture],
        nextCursor: undefined
      }))
    };
    const { adapter } = adapterFor({ ingress, cursorStore, history });

    await expect(adapter.reconcile()).rejects.toThrow("disk unavailable");

    expect(cursorStore.save).not.toHaveBeenCalled();
  });

  it("persists the final history timestamp after paginating reconciliation", async () => {
    // Break caught: persisting a Slack pagination token (or nothing on its final page) replays attachment downloads forever.
    const ingress = acceptedIngress();
    let storedCursor: string | undefined = "170.999";
    const cursorStore = {
      load: vi.fn(async () => storedCursor),
      save: vi.fn(async (cursor: string) => { storedCursor = cursor; })
    };
    const secondMessage = { ...slackMessageFixture, ts: "171.002", text: "follow up" };
    const history = {
      listMessages: vi.fn(async (request: { cursor: string | undefined; pageCursor?: string }) => {
        if (request.pageCursor === "page-2") {
          return { messages: [secondMessage], nextCursor: undefined };
        }
        return { messages: [slackMessageFixture], nextCursor: "page-2" };
      })
    };
    const { adapter } = adapterFor({ ingress, cursorStore, history });

    await adapter.reconcile();
    await adapter.reconcile();

    expect(cursorStore.save).toHaveBeenCalledWith("171.002");
    expect(history.listMessages).toHaveBeenCalledWith({
      channelId: "C123",
      cursor: "171.002",
      pageCursor: undefined
    });
  });

  it("stages a size-limited Slack file without persisting its URL", async () => {
    // Break caught: accepting a provider URL or omitting the content hash exposes transient credentials.
    const directory = await stagingDirectory();
    const ingress = acceptedIngress();
    const fileBytes = new TextEncoder().encode("requirements");
    const adapterWithStaging = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: fileBytes.byteLength,
      stagingDirectory: directory
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield fileBytes; }) }
    });

    await adapterWithStaging.handleEvent({
      ...slackMessageFixture,
      files: [{
        id: "F123",
        name: "requirements.pdf",
        mimetype: "application/pdf",
        size: fileBytes.byteLength,
        url_private: "https://files.slack.com/files-pri/T123-F123/requirements.pdf"
      }]
    });

    const command = ingress.accept.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      attachments: [expect.objectContaining({
        provider: "slack",
        providerFileId: "F123",
        name: "requirements.pdf",
        contentSha256: createHash("sha256").update(fileBytes).digest("hex")
      })]
    });
    expect(JSON.stringify(command)).not.toContain("https://files.slack.com/");
    const [stagedPath] = await stagedFilePaths(directory);
    expect(stagedPath).toBeDefined();
    await expect(readFile(stagedPath!)).resolves.toEqual(Buffer.from(fileBytes));
  });

  it("persists attachment size from the streamed bytes rather than untrusted Slack metadata", async () => {
    // Break caught: a forged Slack file-size field leaves incorrect durable attachment metadata.
    const directory = await stagingDirectory();
    const ingress = acceptedIngress();
    const fileBytes = new TextEncoder().encode("requirements");
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield fileBytes; }) }
    });

    await adapter.handleEvent({
      ...slackMessageFixture,
      files: [{ id: "F456", name: "requirements.pdf", size: 1 }]
    });

    expect(ingress.accept.mock.calls[0]?.[0]).toMatchObject({
      attachments: [expect.objectContaining({ sizeBytes: fileBytes.byteLength })]
    });
  });

  it("writes every byte when the filesystem reports a short write", async () => {
    // Break caught: one FileHandle.write call loses the unwritten suffix after a short write.
    const written: number[] = [];
    const handle = {
      write: vi.fn(async (chunk: Uint8Array) => {
        written.push(chunk[0] ?? -1);
        return { bytesWritten: 1 };
      })
    };
    const bytes = new Uint8Array([7, 8, 9]);

    await writeFully(handle, bytes);

    expect(written).toEqual([7, 8, 9]);
  });

  it("rejects an over-limit stream and removes its partial staging file", async () => {
    // Break caught: writing the first chunk before enforcing the next limit leaves untrusted bytes staged after rejection.
    const directory = await stagingDirectory();
    const stager = createSlackAttachmentStager({
      maxAttachmentBytes: 5,
      stagingDirectory: directory,
      files: {
        download: async function* () {
          yield new Uint8Array([1, 2, 3]);
          yield new Uint8Array([4, 5, 6]);
        }
      }
    });

    await expect(stager({ id: "F789", name: "too-large.pdf" })).rejects.toBeInstanceOf(
      SlackAttachmentTooLargeError
    );
    await expect(readFile(join(directory, "F789"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes every completed sibling when a later Slack file fails to stage", async () => {
    // Break caught: Promise.all rejects on one file while already-created sibling artifacts remain unmanaged.
    const directory = await stagingDirectory();
    let finishFirstDownload: (() => void) | undefined;
    const firstDownloadFinished = new Promise<void>((resolve) => { finishFirstDownload = resolve; });
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: {
        download: vi.fn(async function* (fileId: string) {
          if (fileId === "F-FIRST") {
            yield new Uint8Array([1, 2, 3]);
            finishFirstDownload?.();
            return;
          }
          await firstDownloadFinished;
          throw new Error("second file download failed");
        })
      }
    });

    await expect(adapter.handleEvent({
      ...slackMessageFixture,
      subtype: "file_share",
      files: [
        { id: "F-FIRST", name: "first.txt" },
        { id: "F-SECOND", name: "second.txt" }
      ]
    }, "T123")).rejects.toThrow("second file download failed");

    await vi.waitFor(async () => {
      expect(await stagedFileNames(directory)).toEqual([]);
    });
  });

  it("rolls back all staged Slack files when durable ingress rejects the command", async () => {
    // Break caught: losing ephemeral ownership before ingress leaves every staged file behind on database failure.
    const directory = await stagingDirectory();
    const ingress = acceptedIngress();
    ingress.accept.mockRejectedValueOnce(new Error("durable ingress unavailable"));
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory
    }, {
      ingress,
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); }) }
    });

    await expect(adapter.handleEvent({
      ...slackMessageFixture,
      subtype: "file_share",
      files: [
        { id: "F-FIRST", name: "first.txt" },
        { id: "F-SECOND", name: "second.txt" }
      ]
    }, "T123")).rejects.toThrow("durable ingress unavailable");

    expect(await stagedFileNames(directory)).toEqual([]);
  });

  it("expires successfully handed-off Slack artifacts after the configured retention window", async () => {
    // Break caught: successful ingress without a bounded owner leaves raw Slack files on disk indefinitely.
    const directory = await stagingDirectory();
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory,
      stagedArtifactRetentionMs: 10
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); }) }
    });

    await adapter.handleEvent({
      ...slackMessageFixture,
      subtype: "file_share",
      files: [{ id: "F-EXPIRING", name: "expiring.txt" }]
    }, "T123");
    expect(await stagedFileNames(directory)).toHaveLength(1);

    await vi.waitFor(async () => {
      expect(await stagedFileNames(directory)).toEqual([]);
    });
  });

  it("removes expired managed Slack artifacts during adapter startup", async () => {
    // Break caught: process exit cancels in-memory TTL timers unless startup takes ownership of stale artifacts.
    const directory = await stagingDirectory();
    const ports = {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); }) }
    };
    const firstAdapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory,
      stagedArtifactRetentionMs: 60_000
    }, ports);
    await firstAdapter.handleEvent({
      ...slackMessageFixture,
      subtype: "file_share",
      files: [{ id: "F-STALE", name: "stale.txt" }]
    }, "T123");
    const [stalePath] = await stagedFilePaths(directory);
    expect(stalePath).toBeDefined();
    await utimes(stalePath!, new Date(0), new Date(0));

    const restartedAdapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: directory,
      stagedArtifactRetentionMs: 1_000
    }, ports);

    await restartedAdapter.ready();

    expect(await stagedFileNames(directory)).toEqual([]);
  });

  it("silently denies an unknown Slack user", async () => {
    // Break caught: passing an unbound provider user into command ingress grants command authority.
    const { adapter, ingress } = adapterFor();

    await adapter.handleEvent({ ...slackMessageFixture, user: "U999" });

    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it("silently denies a Socket Mode event from another Slack workspace", async () => {
    // Break caught: resolving an envelope from another team with the configured team grants a colliding user ID authority.
    const { adapter, ingress } = adapterFor();

    await adapter.handleEvent(slackMessageFixture, "T999");

    expect(ingress.accept).not.toHaveBeenCalled();
  });

  it("deduplicates a replayed history message through durable ingress", async () => {
    // Break caught: deriving a new idempotency identity for replay stores the same Slack command twice.
    const database = openDatabase(":memory:");
    const ingress = new ControlStore(database);
    const cursorStore = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined)
    };
    const history = {
      listMessages: vi.fn(async () => ({
        messages: [slackMessageFixture],
        nextCursor: undefined
      }))
    };
    const { adapter } = adapterFor({ ingress, cursorStore, history });

    try {
      await adapter.reconcile();
      await adapter.reconcile();

      expect(ingress.listCommands()).toHaveLength(1);
      expect(cursorStore.save).toHaveBeenCalledWith("171.001");
    } finally {
      database.close();
    }
  });

  it("uses the command thread for an outbound reply", async () => {
    // Break caught: replies without thread_ts create a second, detached Slack conversation.
    const send = vi.fn(async () => ({ ts: "172.001" }));
    const threadedAdapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array(); }) },
      messages: { send }
    });

    await threadedAdapter.deliver({
      id: "outbox-1",
      channel: "slack",
      destination: "C123",
      template: "progress",
      payload: { text: "Working on it", threadId: "171.001" },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    });

    expect(send).toHaveBeenCalledWith({ channel: "C123", text: "Working on it", threadTs: "171.001" });
  });

  it("rejects an outbound Slack reply without its originating thread", async () => {
    // Break caught: allowing an unthreaded delivery creates a detached official record.
    const send = vi.fn(async () => ({ ts: "172.001" }));
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array(); }) },
      messages: { send }
    });

    await expect(adapter.deliver({
      id: "outbox-1",
      channel: "slack",
      destination: "C123",
      template: "progress",
      payload: { text: "Working on it" },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    }))
      .rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("marks local Slack outbound validation as a safe non-retryable failure", async () => {
    // Break caught: a raw ZodError is treated by the dispatcher as a retryable provider outage forever.
    const send = vi.fn(async () => ({ ts: "172.001" }));
    const secretBody = "private outbound body";

    await expect(deliverSlackMessage({
      id: "outbox-invalid-slack",
      channel: "slack",
      destination: "C123",
      template: "progress",
      payload: { text: secretBody },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    }, { send })).rejects.toMatchObject({
      message: "invalid_outbound_message",
      code: "invalid_outbound_message",
      retryable: false
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("propagates a failed Slack delivery for the shared Outbox to retry", async () => {
    // Break caught: swallowing a provider failure lets a dispatcher mark an undelivered message complete.
    const send = vi.fn(async () => { throw new Error("socket_closed"); });
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory()
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array(); }) },
      messages: { send }
    });

    await expect(adapter.deliver({
      id: "outbox-1",
      channel: "slack",
      destination: "C123",
      template: "progress",
      payload: { text: "Working on it", threadId: "171.001" },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    })).rejects.toThrow("socket_closed");
  });

  it("renders a mirrored final summary as a Slack HQ root post", async () => {
    // Break caught: requiring an origin thread on the generated HQ mirror makes cross-channel summaries undeliverable.
    const send = vi.fn(async () => ({ ts: "172.002" }));

    await expect(deliverSlackMessage({
      id: "outbox-telegram:slack-hq",
      commandId: "command-telegram",
      channel: "slack",
      destination: "C-HQ",
      template: "final_summary",
      payload: { text: "Redacted completion summary" },
      attempts: 1,
      nextAttemptAt: "2026-09-01T00:00:00.000Z"
    }, { send })).resolves.toEqual({ providerMessageId: "172.002" });

    expect(send).toHaveBeenCalledWith({
      channel: "C-HQ",
      text: "Redacted completion summary"
    });
  });

  it("normalizes an interactive approval request without approving it", async () => {
    // Break caught: treating an interactive action as an approval bypasses the approval service.
    const accept = vi.fn(async () => ({ kind: "accepted" as const, requestId: "approval-request-1" }));
    const actionAdapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: unusedStagingDirectory(),
      interactiveActionsEnabled: true
    }, {
      ingress: acceptedIngress(),
      identities,
      cursorStore: { load: vi.fn(async () => undefined), save: vi.fn(async () => undefined) },
      history: { listMessages: vi.fn(async () => ({ messages: [], nextCursor: undefined })) },
      files: { download: vi.fn(async function* () { yield new Uint8Array(); }) },
      approvalRequests: { accept }
    });

    await actionAdapter.handleInteractiveAction({
      team: { id: "T123" },
      user: { id: "U123" },
      channel: { id: "C123" },
      container: { message_ts: "171.001" },
      actions: [{ action_id: "approve", action_ts: "171.001100", value: "proposal-1" }]
    });

    expect(accept).toHaveBeenCalledWith({
      channel: "slack",
      teamId: "T123",
      channelId: "C123",
      principalId: "owner",
      messageTs: "171.001",
      actionId: "approve",
      value: "proposal-1",
      idempotencyKey: "abea470796680235f914426fb56547cde1fccff29a93dabf28d412544b34be45",
      trusted: false
    });
  });
});
