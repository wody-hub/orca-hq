import {
  OrcaWorkerProvider,
  type OrcaWorkerProviderOptions
} from "./providers.js";

export class CodexWorkerProvider extends OrcaWorkerProvider {
  constructor(options: OrcaWorkerProviderOptions) {
    super("codex", options);
  }
}
