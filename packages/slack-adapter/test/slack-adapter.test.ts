import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

function adapterFor(options: {
  ingress?: CommandIngress & { accept: ReturnType<typeof vi.fn> };
  cursorStore?: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  history?: { listMessages: ReturnType<typeof vi.fn> };
  files?: { download: ReturnType<typeof vi.fn> };
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
      stagingDirectory: "unused-in-this-test"
    }, { ingress, identities, cursorStore, history, files }),
    ingress,
    cursorStore,
    history
  };
}

describe("Slack adapter", () => {
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

  it("registers Socket Mode message and interactive-action handlers", async () => {
    // Break caught: registering an action handler without a Bolt action constraint leaves approvals undeliverable.
    const ingress = acceptedIngress();
    const { adapter } = adapterFor({ ingress });
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
        actions: [{ action_id: "approve", value: "proposal-1" }]
      }
    });
    expect(ack).toHaveBeenCalledTimes(1);
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
    await expect(readFile(join(directory, "F123"))).resolves.toEqual(Buffer.from(fileBytes));
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
      stagingDirectory: "unused-in-this-test"
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
      stagingDirectory: "unused-in-this-test"
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

  it("propagates a failed Slack delivery for the shared Outbox to retry", async () => {
    // Break caught: swallowing a provider failure lets a dispatcher mark an undelivered message complete.
    const send = vi.fn(async () => { throw new Error("socket_closed"); });
    const adapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: "unused-in-this-test"
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
    const accept = vi.fn(async () => undefined);
    const actionAdapter = createSlackAdapter({
      teamId: "T123",
      channelId: "C123",
      maxAttachmentBytes: 1024,
      stagingDirectory: "unused-in-this-test"
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
      actions: [{ action_id: "approve", value: "proposal-1" }]
    });

    expect(accept).toHaveBeenCalledWith({
      channel: "slack",
      teamId: "T123",
      channelId: "C123",
      principalId: "owner",
      messageTs: "171.001",
      actionId: "approve",
      value: "proposal-1",
      trusted: false
    });
  });
});
