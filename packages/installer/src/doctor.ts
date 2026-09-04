import { z } from "zod";

export const DoctorCheckSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  message: z.string(),
  remediation: z.string().optional()
}).strict();

export const DoctorResultSchema = z.object({
  ok: z.boolean(),
  checks: z.array(DoctorCheckSchema)
}).strict();

export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;
export type DoctorResult = z.infer<typeof DoctorResultSchema>;
export type CheckStatus = DoctorCheck["status"];

export const pilotCheckDefinitions = Object.freeze([
  { key: "macosCpu", id: "host.macos-cpu", label: "supported macOS and CPU", remediation: "Use a supported macOS host and CPU." },
  { key: "nodePnpm", id: "runtime.node-pnpm", label: "Node and pnpm", remediation: "Install the supported Node and pnpm versions." },
  { key: "orcaCapabilities", id: "orca.capabilities", label: "Orca version and capabilities", remediation: "Update Orca to a compatible version." },
  { key: "codexAuthentication", id: "codex.authentication", label: "Codex authentication", remediation: "Complete Codex authentication." },
  { key: "claudeAuthentication", id: "claude.authentication", label: "Claude authentication", remediation: "Complete Claude authentication." },
  { key: "tailscaleTailnet", id: "tailscale.tailnet", label: "Tailscale tailnet", remediation: "Connect this host to the approved tailnet." },
  { key: "slackSocketMode", id: "slack.socket-mode", label: "Slack Socket Mode and channel", remediation: "Configure the approved Slack Socket Mode channel." },
  { key: "telegramAllowlistedChat", id: "telegram.allowlisted-chat", label: "Telegram allowlisted chat", remediation: "Configure an approved Telegram chat." },
  { key: "openAiVoice", id: "openai.voice", label: "OpenAI voice", remediation: "Configure approved OpenAI voice access." },
  { key: "keychain", id: "keychain.access", label: "Keychain access", remediation: "Allow the installer Keychain adapter to store credentials." },
  { key: "sqliteDirectory", id: "sqlite.directory", label: "SQLite directory", remediation: "Choose a writable SQLite data directory." },
  { key: "launchd", id: "launchd.readiness", label: "launchd readiness", remediation: "Review the launchd service definition before installation." },
  { key: "projectDiscovery", id: "projects.discovery", label: "project discovery", remediation: "Discover and approve pilot projects in Orca." }
] as const);

type PilotCheckKey = (typeof pilotCheckDefinitions)[number]["key"];

export type PilotCheckPorts = Readonly<Record<PilotCheckKey, () => Promise<CheckStatus>>>;

export interface RegistryReviewPort {
  review(): Promise<Readonly<{ status: CheckStatus; curatedProjects: number }>>;
}

export interface DoctorPorts {
  readonly checks: PilotCheckPorts;
  readonly registry: RegistryReviewPort;
}

export interface DoctorRunOptions {
  readonly format: "json";
}

function checkResult(
  definition: (typeof pilotCheckDefinitions)[number],
  status: CheckStatus
): DoctorCheck {
  return {
    id: definition.id,
    status,
    message: status === "pass" ? `${definition.label} is ready.` : `${definition.label} needs attention.`,
    ...(status === "pass" ? {} : { remediation: definition.remediation })
  };
}

async function runCheck(
  definition: (typeof pilotCheckDefinitions)[number],
  ports: DoctorPorts
): Promise<DoctorCheck> {
  try {
    return checkResult(definition, await ports.checks[definition.key]());
  } catch {
    return checkResult(definition, "fail");
  }
}

async function registryCheck(registry: RegistryReviewPort): Promise<DoctorCheck> {
  try {
    const review = await registry.review();
    const status: CheckStatus = review.status === "fail"
      ? "fail"
      : review.curatedProjects === 5 ? review.status : "warn";
    return {
      id: "registry.five-project-curation",
      status,
      message: status === "pass" ? "Five pilot projects are curated." : "Five pilot projects need review.",
      ...(status === "pass" ? {} : { remediation: "Curate exactly five approved pilot projects." })
    };
  } catch {
    return {
      id: "registry.five-project-curation",
      status: "fail",
      message: "Five pilot projects need review.",
      remediation: "Curate exactly five approved pilot projects."
    };
  }
}

export function createDoctor(ports: DoctorPorts): Readonly<{
  run(options: DoctorRunOptions): Promise<DoctorResult>;
}> {
  return Object.freeze({
    async run(_options: DoctorRunOptions): Promise<DoctorResult> {
      const checks = await Promise.all([
        ...pilotCheckDefinitions.map((definition) => runCheck(definition, ports)),
        registryCheck(ports.registry)
      ]);
      // Reports contain only fixed text, status and counts-derived status. Adapter output is never emitted.
      return DoctorResultSchema.parse({ ok: !checks.some((check) => check.status === "fail"), checks });
    }
  });
}

export async function doctorExitCode(result: DoctorResult): Promise<number> {
  return result.checks.some((check) => check.status === "fail") ? 1 : 0;
}
