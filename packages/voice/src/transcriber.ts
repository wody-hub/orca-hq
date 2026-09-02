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
