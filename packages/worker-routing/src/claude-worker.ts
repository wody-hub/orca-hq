import {
  OrcaWorkerProvider,
  type OrcaWorkerProviderOptions
} from "./providers.js";

export class ClaudeWorkerProvider extends OrcaWorkerProvider {
  constructor(options: OrcaWorkerProviderOptions) {
    super("claude", options);
  }
}
