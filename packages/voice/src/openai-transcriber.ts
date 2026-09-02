import {
  TranscriptionResponseSchema,
  type TranscriptionResponse,
  type VoiceTranscriber
} from "./transcriber.js";

/** Credential access is injected so this package never reads Keychain or configuration directly. */
export type OpenAiCredentialProvider = Readonly<{
  getOpenAiApiKey(): Promise<string>;
}>;

/** The composition root provides the real client; tests supply a fake and no request is made here. */
export type OpenAiTranscriptionClient = Readonly<{
  transcribe(input: Readonly<{
    path: string;
    language: "ko";
    apiKey: string;
  }>): Promise<TranscriptionResponse>;
}>;

export function createOpenAiTranscriber(options: Readonly<{
  credentials: OpenAiCredentialProvider;
  openai: OpenAiTranscriptionClient;
}>): VoiceTranscriber {
  return {
    id: "openai",
    transcribe: async (input) => {
      const apiKey = await options.credentials.getOpenAiApiKey();
      const response = await options.openai.transcribe({ ...input, apiKey });
      return TranscriptionResponseSchema.parse(response);
    }
  };
}
