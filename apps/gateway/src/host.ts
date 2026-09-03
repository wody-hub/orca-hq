import type { OrcaClient } from "@orca-hq/orca-adapter";
import type { OutboxDispatcherOptions } from "@orca-hq/persistence";
import {
  GitWorktreePlacementService,
  FileAssignmentArtifactStore,
  type GitWorktreePort,
  type VerificationEvidencePort,
  type WorkerProviderRegistryPort
} from "@orca-hq/worker-routing";
import {
  DiscoveredProjectSchema,
  Registry,
  type DiscoveredProject,
  type ProjectRegistryEntry
} from "@orca-hq/project-registry";
import type { ServeConfiguration } from "@orca-hq/tailscale-adapter";
import { z } from "zod";

import { validateGatewayConfig, type GatewayConfig } from "./config.js";
import type {
  GatewayConfigPort,
  GatewayIngressPort,
  GatewayTransactionPort
} from "./lifecycle.js";
import type { GatewayHttpOptions } from "./http.js";
import type {
  GatewayDispatchControlPort,
  GatewayProductionDependencies,
  GatewayProposalModelPort
} from "./production.js";

type OutboundProviders = Omit<
  OutboxDispatcherOptions,
  "store" | "workerId" | "slackHqDestination"
>["providers"];

export type GatewayHostSettings = Readonly<{
  gateway: GatewayConfig;
  projectRegistryPath: string;
  discoveredProjects: readonly DiscoveredProject[];
  assignmentArtifactRootDirectory: string;
  outboxWorkerId: string;
  slackHqDestination?: string | undefined;
  completionDestinations: Readonly<{
    slack: string;
    tailscaleWeb: string;
  }>;
  serveConfiguration: Omit<ServeConfiguration, "gatewayHttpPort">;
}>;

/**
 * Deployment supplies only environment, secret and external-I/O boundaries.
 * It cannot supply a command flow, reconciliation hook, ExecutionService,
 * OutboxDispatcher, HTTP app, or complete production dependency graph.
 */
export interface GatewayExternalBoundaries {
  readonly settings: GatewayHostSettings;
  readonly secrets: GatewayConfigPort;
  readonly orca: Pick<OrcaClient, "health" | "execute">;
  readonly proposalModel: GatewayProposalModelPort;
  readonly git: GitWorktreePort;
  readonly verificationEvidence: VerificationEvidencePort;
  readonly providerRegistry?: WorkerProviderRegistryPort | undefined;
  readonly httpOptions: Omit<GatewayHttpOptions, "commands" | "projects" | "approvals" | "actions">;
  readonly slack: GatewayIngressPort;
  readonly telegram: GatewayIngressPort;
  readonly transactions: GatewayTransactionPort;
  readonly outboundProviders: OutboundProviders;
  readonly dispatchControl: GatewayDispatchControlPort;
  readonly now?: (() => Date) | undefined;
}

export type GatewayExternalBoundaryLoader = () => Promise<unknown>;

export type GatewayHost = Readonly<{
  config: GatewayConfig;
  dependencies: GatewayProductionDependencies;
}>;

export type GatewayHostFactory = () => Promise<GatewayHost>;

const NonBlankStringSchema = z.string().trim().min(1);
const CompletionDestinationsSchema = z.object({
  slack: NonBlankStringSchema,
  tailscaleWeb: NonBlankStringSchema
}).strict();
const ServeConfigurationSchema = z.object({
  funnelEnabled: z.boolean(),
  publicExposure: z.boolean(),
  gatewayBindAddress: NonBlankStringSchema,
  upstreamAddress: NonBlankStringSchema,
  httpsEnabled: z.boolean(),
  advertisedHost: NonBlankStringSchema,
  expectedTailnetDnsSuffix: NonBlankStringSchema
}).strict();

function unavailable(): Error {
  return new Error("Gateway configuration or secret provider is unavailable");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireMethods(value: unknown, names: readonly string[]): void {
  const candidate = object(value);
  if (candidate === undefined || names.some((name) => typeof candidate[name] !== "function")) {
    throw unavailable();
  }
}

function validatedBoundaries(value: unknown): GatewayExternalBoundaries {
  const candidate = object(value);
  if (candidate === undefined || [
    "dependencies",
    "commandFlow",
    "reconcile",
    "execution",
    "outbox",
    "gateway",
    "host"
  ].some((key) => key in candidate)) {
    throw unavailable();
  }
  const settings = object(candidate.settings);
  const httpOptions = object(candidate.httpOptions);
  const outboundProviders = object(candidate.outboundProviders);
  if (settings === undefined || httpOptions === undefined || outboundProviders === undefined) {
    throw unavailable();
  }
  try {
    const gateway = validateGatewayConfig(settings.gateway as GatewayConfig);
    const projectRegistryPath = NonBlankStringSchema.parse(settings.projectRegistryPath);
    const discoveredProjects = DiscoveredProjectSchema.array().min(1).parse(
      settings.discoveredProjects
    );
    const assignmentArtifactRootDirectory = NonBlankStringSchema.parse(
      settings.assignmentArtifactRootDirectory
    );
    const outboxWorkerId = NonBlankStringSchema.parse(settings.outboxWorkerId);
    const completionDestinations = CompletionDestinationsSchema.parse(
      settings.completionDestinations
    );
    const serveConfiguration = ServeConfigurationSchema.parse(
      settings.serveConfiguration
    );
    requireMethods(candidate.secrets, ["validate"]);
    requireMethods(candidate.orca, ["health", "execute"]);
    requireMethods(candidate.proposalModel, ["plan"]);
    requireMethods(candidate.git, [
      "repositoryStatus",
      "resolveRevision",
      "branchOccupancy",
      "pathExists",
      "createWorktree"
    ]);
    requireMethods(candidate.verificationEvidence, [
      "collectImplementation",
      "collectVerifierCommands",
      "captureRepositorySnapshot"
    ]);
    requireMethods(candidate.slack, ["start", "stopIngress"]);
    requireMethods(candidate.telegram, ["start", "stopIngress"]);
    requireMethods(candidate.transactions, ["drain"]);
    requireMethods(candidate.dispatchControl, ["stop", "retry"]);
    requireMethods(httpOptions.resolver, ["resolve"]);
    requireMethods(httpOptions.sessions, ["startLocalSession", "verify"]);
    if (candidate.providerRegistry !== undefined) requireMethods(candidate.providerRegistry, ["get"]);
    for (const channel of ["slack", "telegram", "tailscale-web"] as const) {
      if (outboundProviders[channel] !== undefined) {
        requireMethods(outboundProviders[channel], ["deliver"]);
      }
    }
    const normalizedSettings: GatewayHostSettings = Object.freeze({
      gateway,
      projectRegistryPath,
      discoveredProjects: Object.freeze(
        discoveredProjects.map((project) => Object.freeze({ ...project }))
      ),
      assignmentArtifactRootDirectory,
      outboxWorkerId,
      completionDestinations: Object.freeze({ ...completionDestinations }),
      serveConfiguration: Object.freeze({ ...serveConfiguration }),
      ...(settings.slackHqDestination === undefined
        ? {}
        : { slackHqDestination: NonBlankStringSchema.parse(settings.slackHqDestination) })
    });
    return Object.freeze({
      ...(candidate as unknown as GatewayExternalBoundaries),
      settings: normalizedSettings
    });
  } catch {
    throw unavailable();
  }
}

/** Repository-owned assembly of registry, execution, verification, Outbox and lifecycle dependencies. */
export function assembleGatewayHost(boundariesValue: unknown): GatewayHost {
  const boundaries = validatedBoundaries(boundariesValue);
  const settings = boundaries.settings;
  let projects: readonly ProjectRegistryEntry[];
  try {
    projects = Object.freeze(
      Registry.load(settings.projectRegistryPath, settings.discoveredProjects)
        .map((project) => Object.freeze({ ...project }))
    );
  } catch {
    throw unavailable();
  }
  const dependencies: GatewayProductionDependencies = {
    config: boundaries.secrets,
    orca: boundaries.orca,
    proposalModel: boundaries.proposalModel,
    projects,
    execution: {
      placements: new GitWorktreePlacementService(boundaries.git),
      assignmentArtifacts: new FileAssignmentArtifactStore({
        rootDirectory: settings.assignmentArtifactRootDirectory
      }),
      verificationEvidence: boundaries.verificationEvidence,
      providerCapabilities: {
        codex: { worker: "available", hq: "available" },
        claude: { worker: "available", hq: "unavailable" },
        providerChildEnvironmentIsolation: {
          kind: "verified_effective_allowlist",
          effectiveEnvironmentKeys: ["HOME", "PATH"]
        },
        assignmentArtifactAccess: { kind: "same_host" }
      },
      ...(boundaries.providerRegistry === undefined
        ? {}
        : { providers: boundaries.providerRegistry })
    },
    httpOptions: boundaries.httpOptions,
    slack: boundaries.slack,
    telegram: boundaries.telegram,
    transactions: boundaries.transactions,
    outbox: {
      workerId: settings.outboxWorkerId,
      providers: boundaries.outboundProviders,
      ...(settings.slackHqDestination === undefined
        ? {}
        : { slackHqDestination: settings.slackHqDestination })
    },
    dispatchControl: boundaries.dispatchControl,
    completionDestinations: settings.completionDestinations,
    serveConfiguration: settings.serveConfiguration,
    ...(boundaries.now === undefined ? {} : { now: boundaries.now })
  };
  return Object.freeze({ config: settings.gateway, dependencies: Object.freeze(dependencies) });
}

async function loadExternalBoundaries(): Promise<unknown> {
  const moduleUrl = process.env.GATEWAY_EXTERNAL_ADAPTERS;
  if (moduleUrl === undefined || !moduleUrl.startsWith("file:")) throw unavailable();
  const loaded = object(await import(moduleUrl));
  if (loaded === undefined || typeof loaded.createGatewayExternalBoundaries !== "function") {
    throw unavailable();
  }
  return await loaded.createGatewayExternalBoundaries();
}

/** Loads and validates only external boundaries, then invokes repository-owned assembly. */
export async function createGatewayHost(
  load: GatewayExternalBoundaryLoader = loadExternalBoundaries
): Promise<GatewayHost> {
  return assembleGatewayHost(await load());
}
