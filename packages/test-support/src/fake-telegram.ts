import type {
  CommandEnvelope,
  CommandIngress,
  IdentityResolver
} from "@orca-hq/core";
import {
  createTelegramAdapter,
  toTelegramVoiceCommand,
  type TelegramVoiceMessage
} from "@orca-hq/telegram-adapter";
import type { Transcript } from "@orca-hq/voice";

export interface FakeTelegramOptions {
  readonly ingress: CommandIngress;
  readonly identities: IdentityResolver;
  readonly nextId: (kind: string) => string;
  readonly cursorStore?: Readonly<{
    load(channel: "telegram"): Promise<number | undefined> | number | undefined;
    save(channel: "telegram", cursor: number): Promise<void> | void;
  }>;
}

export class FakeTelegram {
  readonly #options: FakeTelegramOptions;
  readonly #deniedRiskLevels: string[] = [];
  readonly #adapter;
  #connected = false;
  #cursor: number | undefined;
  #pendingVoice: TelegramVoiceMessage | undefined;
  #pendingTranscript: Transcript | undefined;

  constructor(options: FakeTelegramOptions) {
    this.#options = options;
    this.#adapter = createTelegramAdapter({
      botIdentity: "pilot-bot",
      maxVoiceBytes: 1_024
    }, {
      identities: options.identities,
      ingress: {
        accept: (command) => options.ingress.accept({
          ...command,
          commandId: options.nextId("command")
        })
      },
      cursorStore: {
        load: async () => this.#options.cursorStore?.load("telegram") ?? this.#cursor,
        save: async (_channel, offset) => {
          this.#cursor = offset;
          await this.#options.cursorStore?.save("telegram", offset);
        }
      },
      outbox: {
        enqueue: async (message) => { this.#deniedRiskLevels.push(message.payload.riskLevel); }
      },
      approvalPort: { async request() {} },
      voice: {
        media: {
          download: async () => (async function* () {
            yield new TextEncoder().encode("synthetic-korean-voice");
          })()
        },
        transcriber: {
          transcribe: async () => ({
            provider: "openai",
            sourceFileSha256: "a".repeat(64),
            confidence: 0.7,
            text: "샌드박스 프런트엔드 테스트를 수정해줘"
          })
        },
        confirmations: {
          request: async ({ confirmationText }) => {
            if (this.#pendingVoice === undefined) throw new Error("voice fixture is missing");
            this.#pendingTranscript = {
              provider: "openai",
              sourceFileSha256: "a".repeat(64),
              confidence: 1,
              text: confirmationText
            };
          }
        }
      }
    });
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

  get cursor(): number | undefined {
    return this.#cursor;
  }

  async reconnectFromCursor(): Promise<void> {
    this.#cursor = await this.#options.cursorStore?.load("telegram") ?? this.#cursor;
    this.#connected = true;
  }

  get confirmationRequired(): boolean {
    return this.#pendingTranscript !== undefined;
  }

  get deniedRiskLevels(): readonly string[] {
    return [...this.#deniedRiskLevels];
  }

  async sendText(input: Readonly<{ text: string; messageId: number; updateId: number }>): Promise<void> {
    this.#assertConnected();
    await this.#adapter.handleUpdate({
      update_id: input.updateId,
      message: {
        message_id: input.messageId,
        date: 1_788_451_200,
        from: { id: 10 },
        chat: { id: 20 },
        text: input.text
      }
    });
  }

  async sendVoice(input: Readonly<{ messageId: number; updateId: number }>): Promise<void> {
    this.#assertConnected();
    this.#pendingVoice = {
      message_id: input.messageId,
      date: 1_788_451_200,
      from: { id: 10 },
      chat: { id: 20 },
      voice: {
        file_id: "fake-voice-file",
        file_unique_id: "fake-voice-unique",
        duration: 2,
        file_size: 22
      }
    };
    await this.#adapter.handleUpdate({ update_id: input.updateId, message: this.#pendingVoice });
  }

  async approveTranscript(): Promise<Readonly<{ kind: "accepted" | "duplicate"; commandId: string }>> {
    if (this.#pendingVoice === undefined || this.#pendingTranscript === undefined) {
      throw new Error("no synthetic transcript awaits confirmation");
    }
    const normalized = toTelegramVoiceCommand(
      { message: this.#pendingVoice },
      "owner",
      "pilot-bot",
      this.#pendingTranscript
    );
    const command: CommandEnvelope = {
      ...normalized,
      commandId: this.#options.nextId("command")
    };
    this.#pendingTranscript = undefined;
    return this.#options.ingress.accept(command);
  }

  async requestPrivilegedApproval(level: "L2" | "L3", updateId: number): Promise<void> {
    this.#assertConnected();
    await this.#adapter.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 10 },
        message: { message_id: updateId, chat: { id: 20 } },
        data: `approval:${level}`
      }
    });
  }

  #assertConnected(): void {
    if (!this.#connected) throw new Error("fake Telegram is disconnected");
  }
}
