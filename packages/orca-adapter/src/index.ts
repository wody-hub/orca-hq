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
import {
  runOrca,
  type OrcaConnectionTarget
} from "./process.js";
import {
  assertSuccessfulReceipt,
  OrcaInvalidReceiptError,
  parseOrcaOperationReceipt,
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
  readonly terminationGraceMs?: number;
  readonly connectionTarget?: OrcaConnectionTarget;
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
  providerChildEnvironmentIsolation: Readonly<{
    kind: "unsupported";
    reason: "public_worker_start_has_no_child_environment_contract";
  }>;
  assignmentArtifactAccess: Readonly<
    | { kind: "same_host" }
    | {
        kind: "unsupported";
        reason: "saved_environment_has_no_assignment_artifact_transport";
      }
  >;
  skills: readonly OrcaSkillBinding[];
}>;

interface StartupState {
  readonly health: OrcaHealth;
  readonly skills: ReadonlyMap<OfficialOrcaSkillName, LoadedOrcaSkill>;
}

const officialSkillNames = ["orca-cli", "orchestration"] as const;

export class OrcaClient {
  readonly #options: OrcaClientOptions & Required<Pick<
    OrcaClientOptions,
    "timeoutMs" | "terminationGraceMs" | "connectionTarget"
  >>;
  #startup?: Promise<StartupState>;

  constructor(options: OrcaClientOptions) {
    assertVersionRange(options.expectedVersionRange);
    if (options.executablePath.length === 0) throw new TypeError("executablePath is required");
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a positive safe integer");
    }
    const terminationGraceMs = options.terminationGraceMs ?? 250;
    if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
      throw new TypeError("terminationGraceMs must be a positive safe integer");
    }
    const connectionTarget = options.connectionTarget ?? Object.freeze({ kind: "local" as const });
    this.#options = Object.freeze({
      ...options,
      timeoutMs,
      terminationGraceMs,
      connectionTarget: Object.freeze({ ...connectionTarget })
    });
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
    let raw: unknown;
    try {
      raw = await runOrca(operationArguments(operation), this.#options);
      const receipt = parseOrcaReceipt(raw);
      assertSuccessfulReceipt(receipt);
      const parsed = parseOrcaOperationReceipt(operation.kind, receipt);
      if (operation.kind === "dispatch_worker") {
        const result = parsed.result as { taskId?: unknown };
        if (result.taskId !== operation.taskId) throw new OrcaInvalidReceiptError();
      }
      return parsed;
    } catch (error) {
      if (
        operation.kind !== "dispatch_worker"
        || (error as { code?: unknown })?.code === "orca_command_failed"
      ) throw error;
      const uncertain = error instanceof Error
        ? error
        : Object.assign(new Error("Orca worker-start outcome is uncertain"), {
            code: "orca_worker_start_uncertain"
          });
      Object.assign(uncertain, {
        workerMayBeLive: true
      });
      throw uncertain;
    }
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
      providerChildEnvironmentIsolation: Object.freeze({
        kind: "unsupported" as const,
        reason: "public_worker_start_has_no_child_environment_contract" as const
      }),
      assignmentArtifactAccess: this.#options.connectionTarget.kind === "local"
        ? Object.freeze({ kind: "same_host" as const })
        : Object.freeze({
            kind: "unsupported" as const,
            reason: "saved_environment_has_no_assignment_artifact_transport" as const
          }),
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
  orcaConnectionArguments,
  OrcaProcessError,
  OrcaTimeoutError,
  type OrcaConnectionTarget,
} from "./process.js";
export {
  OrcaCommandError,
  OrcaInvalidReceiptError,
  OrcaReceiptSchema,
  OrcaStaleHandleError,
  parseOrcaOperationReceipt,
  type OrcaProject,
  type OrcaReceipt
} from "./receipts.js";
