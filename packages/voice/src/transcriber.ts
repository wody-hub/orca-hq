import type { Readable } from "node:stream";

import { z } from "zod";

import { temporaryAudioFile, writeAndHash } from "./audio-retention.js";

export const TranscriberIdSchema = z.enum(["openai", "local-whisper"]);

const TranscribedTextSchema = z.string().transform((text) => text.trim()).pipe(z.string().min(1));

export const TranscriptionResponseSchema = z.object({
  text: TranscribedTextSchema,
  confidence: z.number().min(0).max(1).optional()
}).strict();

export const TranscriptSchema = TranscriptionResponseSchema.extend({
  provider: TranscriberIdSchema,
  sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type Transcript = z.infer<typeof TranscriptSchema>;
export type TranscriptionResponse = z.infer<typeof TranscriptionResponseSchema>;

export class VoiceMediaTooLargeError extends Error {
  readonly code = "voice_media_too_large";

  constructor() {
    super("voice media exceeds the configured byte limit");
    this.name = "VoiceMediaTooLargeError";
  }
}

function validateVoiceByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
}

export function assertVoiceMediaSize(declaredBytes: number | undefined, maxBytes: number): void {
  validateVoiceByteLimit(maxBytes);
  if (declaredBytes !== undefined && declaredBytes > maxBytes) throw new VoiceMediaTooLargeError();
}

/** Counts untrusted media while consumed, before an over-limit chunk reaches temp storage. */
export async function* limitVoiceMediaBytes(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
  validateVoiceByteLimit(maxBytes);
  let byteCount = 0;
  for await (const chunk of stream) {
    if (chunk.byteLength > maxBytes - byteCount) throw new VoiceMediaTooLargeError();
    byteCount += chunk.byteLength;
    yield chunk;
  }
}

export type TranscriptDecision =
  | Readonly<{ kind: "command"; transcript: Transcript }>
  | Readonly<{ kind: "confirmation_required"; confirmationText: string }>;

/** Parses once for every adapter and prevents low-confidence text becoming command text. */
export function decideTranscript(input: unknown): TranscriptDecision | undefined {
  const transcript = TranscriptSchema.safeParse(input);
  if (!transcript.success) return undefined;
  if (transcript.data.confidence !== undefined && transcript.data.confidence < 0.8) {
    return { kind: "confirmation_required", confirmationText: transcript.data.text };
  }
  return { kind: "command", transcript: transcript.data };
}

export type VoiceTranscriber = Readonly<{
  id: z.infer<typeof TranscriberIdSchema>;
  transcribe(input: Readonly<{ path: string; language: "ko" }>): Promise<TranscriptionResponse>;
}>;

export type IngestedTranscript = Transcript & Readonly<{ temporaryPath: string }>;

export type VoiceIngestionOptions = Readonly<{
  /** Voice transcription is deliberately fixed to Korean for this channel contract. */
  language?: "ko";
  /** Audio is deleted unless a diagnostic caller explicitly opts into retention. */
  retain?: boolean;
}>;

export type VoiceIngestionService = Readonly<{
  ingest(stream: Readable, options: VoiceIngestionOptions): Promise<IngestedTranscript>;
}>;

/** A channel-facing port deliberately omits the ephemeral temporary path. */
export type VoiceCommandTranscriber = Readonly<{
  transcribe(stream: Readable): Promise<Transcript>;
}>;

export type VoiceOptions = VoiceIngestionOptions & Readonly<{
  temporaryDirectory?: string;
  transcriber: VoiceTranscriber;
}>;

export async function ingestVoice(stream: Readable, options: VoiceOptions): Promise<IngestedTranscript> {
  const file = await temporaryAudioFile(options.temporaryDirectory);
  try {
    const sourceFileSha256 = await writeAndHash(stream, file.path);
    const response = await options.transcriber.transcribe({ path: file.path, language: "ko" });
    return {
      ...TranscriptSchema.parse({
        ...response,
        provider: options.transcriber.id,
        sourceFileSha256
      }),
      temporaryPath: file.path
    };
  } finally {
    if (options.retain !== true) await file.remove();
  }
}

export function createVoiceIngestionService(options: Readonly<{
  temporaryDirectory?: string;
  transcriber: VoiceTranscriber;
}>): VoiceIngestionService {
  return {
    ingest: (stream, ingestOptions) => ingestVoice(stream, { ...options, ...ingestOptions })
  };
}

export function createVoiceCommandTranscriber(service: VoiceIngestionService): VoiceCommandTranscriber {
  return {
    transcribe: async (stream) => {
      const { temporaryPath: _temporaryPath, ...transcript } = await service.ingest(stream, { language: "ko" });
      return transcript;
    }
  };
}
