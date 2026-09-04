import type {
  CommandEnvelope,
  CommandIngress,
  IdentityResolver
} from "@orca-hq/core";
import {
  toCommandEnvelope,
  type SlackAttachmentStager
} from "@orca-hq/slack-adapter";

export interface FakeSlackOptions {
  readonly ingress: CommandIngress;
  readonly identities: IdentityResolver;
  readonly nextId: (kind: string) => string;
}

export class FakeSlack {
  readonly #options: FakeSlackOptions;
  #connected = false;
  #cursor: string | undefined;

  constructor(options: FakeSlackOptions) {
    this.#options = options;
  }

  connect(): void {
    this.#connected = true;
  }

  disconnect(): void {
    this.#connected = false;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get cursor(): string | undefined {
    return this.#cursor;
  }

  async sendText(input: Readonly<{ text: string; timestamp: string }>) {
    if (!this.#connected) throw new Error("fake Slack is disconnected");
    const stageAttachment = Object.assign(
      async () => { throw new Error("synthetic text fixtures have no attachments"); },
      { ready: Promise.resolve() }
    ) as SlackAttachmentStager;
    const prepared = await toCommandEnvelope({
      type: "message",
      channel: "C-PILOT",
      user: "U-OWNER",
      text: input.text,
      ts: input.timestamp
    }, {
      teamId: "T-PILOT",
      channelId: "C-PILOT"
    }, {
      identities: this.#options.identities,
      stageAttachment
    });
    if (prepared === undefined) throw new Error("synthetic Slack fixture was rejected");
    const command: CommandEnvelope = {
      ...prepared.command,
      commandId: this.#options.nextId("command")
    };
    this.#cursor = input.timestamp;
    return this.#options.ingress.accept(command);
  }
}
