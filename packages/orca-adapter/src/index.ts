import { createHash } from "node:crypto";

import {
  assertVersionRange,
  isMutation,
  missingCapabilities,
  operationArguments,
  OrcaIncompatibleError,
  parseOrcaOperation,
  versionIsCompatible,
  type OrcaOperation
} from "./capabilities.js";
import { runOrca } from "./process.js";
import {
  assertSuccessfulReceipt,
  OrcaInvalidReceiptError,
  parseOrcaProjects,
  parseOrcaReceipt,
  parseOrcaSkillResponse,
  parseOrcaStatusReceipt,
  type OrcaProject,
  type OrcaReceipt
} from "./receipts.js";

export type OfficialOrcaSkillName = "orca-cli" | "orchestration";

export interface OrcaClientOptions {
  readonly executablePath: string;
  readonly signal: AbortSignal;
  readonly expectedVersionRange: string;
  readonly timeoutMs?: number;
}

export type LoadedOrcaSkill = Readonly<{
  name: OfficialOrcaSkillName;
  text: string;
  sha256: string;
  orcaVersion: string;
}>;

export type OrcaSkillBinding = Readonly<Omit<LoadedOrcaSkill, "text">>;

export type OrcaHealth = Readonly<{
  compatible: boolean;
  version: string;
  capabilities: readonly string[];
  missingCapabilities: readonly string[];
  skills: readonly OrcaSkillBinding[];
}>;

interface StartupState {
  readonly health: OrcaHealth;
  readonly skills: ReadonlyMap<OfficialOrcaSkillName, LoadedOrcaSkill>;
}

const officialSkillNames = ["orca-cli", "orchestration"] as const;

export class OrcaClient {
  readonly #options: Required<Pick<OrcaClientOptions, "timeoutMs">> & OrcaClientOptions;
  #startup?: Promise<StartupState>;

  constructor(options: OrcaClientOptions) {
    assertVersionRange(options.expectedVersionRange);
    if (options.executablePath.length === 0) throw new TypeError("executablePath is required");
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive safe integer");
    }
    this.#options = Object.freeze({ ...options, timeoutMs });
  }

  async health(): Promise<OrcaHealth> {
    return (await this.#startupState()).health;
  }

  async loadSkill(name: OfficialOrcaSkillName): Promise<LoadedOrcaSkill> {
    const skill = (await this.#startupState()).skills.get(name);
    if (skill === undefined) throw new TypeError(`unsupported official Orca skill: ${name}`);
    return skill;
  }

  async discoverProjects(): Promise<readonly OrcaProject[]> {
    const receipt = await this.execute({ kind: "list_projects" });
    return parseOrcaProjects(receipt);
  }

  async execute(operationInput: OrcaOperation): Promise<OrcaReceipt> {
    const operation = parseOrcaOperation(operationInput);
    const { health } = await this.#startupState();
    if (isMutation(operation) && !health.compatible) throw new OrcaIncompatibleError();
    const raw = await runOrca(operationArguments(operation), this.#options);
    const receipt = parseOrcaReceipt(raw);
    assertSuccessfulReceipt(receipt);
    return receipt;
  }

  #startupState(): Promise<StartupState> {
    this.#startup ??= this.#initialize();
    return this.#startup;
  }

  async #initialize(): Promise<StartupState> {
    const status = parseOrcaStatusReceipt(await runOrca(["status"], this.#options));
    const version = status.result.runtime.appVersion;
    const capabilities = Object.freeze([...status.result.runtime.capabilities]);
    const absent = Object.freeze([...missingCapabilities(capabilities)]);
    const loadedSkills = new Map<OfficialOrcaSkillName, LoadedOrcaSkill>();

    for (const name of officialSkillNames) {
      const response = parseOrcaSkillResponse(await runOrca(["skills", "get", name], this.#options));
      if (response.name !== name) {
        throw new OrcaInvalidReceiptError();
      }
      const skill = Object.freeze({
        name,
        text: response.markdown,
        sha256: createHash("sha256").update(response.markdown).digest("hex"),
        orcaVersion: version
      });
      loadedSkills.set(name, skill);
    }

    const skills = Object.freeze(officialSkillNames.map((name) => {
      const { text: _text, ...binding } = loadedSkills.get(name) as LoadedOrcaSkill;
      return Object.freeze(binding);
    }));
    const compatible = status.result.runtime.state === "ready"
      && status.result.runtime.reachable
      && versionIsCompatible(version, this.#options.expectedVersionRange)
      && absent.length === 0;
    const health = Object.freeze({
      compatible,
      version,
      capabilities,
      missingCapabilities: absent,
      skills
    });
    return Object.freeze({ health, skills: loadedSkills });
  }
}

export {
  MINIMUM_ORCA_VERSION,
  REQUIRED_ORCA_CAPABILITIES,
  OrcaIncompatibleError,
  type OrcaOperation
} from "./capabilities.js";
export {
  OrcaAbortedError,
  OrcaProcessError,
  OrcaTimeoutError,
} from "./process.js";
export {
  OrcaCommandError,
  OrcaInvalidReceiptError,
  OrcaReceiptSchema,
  OrcaStaleHandleError,
  type OrcaProject,
  type OrcaReceipt
} from "./receipts.js";
