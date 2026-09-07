import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { Registry, type ProjectRegistryEntry } from "@orca-hq/project-registry";

const execute = promisify(execFile);
const METADATA_FILE = "managed-projects.json";
const MAX_PATH_LENGTH = 4_096;

export type SetupPolicy = "run" | "skip" | "inherit";

export interface ManagedProject {
  readonly id: string;
  readonly name: string;
  readonly absolutePath: string;
  readonly aliases: readonly string[];
  readonly enabled: boolean;
  readonly sensitivePaths: readonly string[];
  readonly setupPolicy: SetupPolicy;
  readonly defaultBaseRef?: string;
}

export interface ProjectCatalog {
  list(): Promise<ManagedProject[]>;
  resolve(selector: string): Promise<ManagedProject>;
  add(path: string): Promise<ManagedProject>;
  alias(selector: string, alias: string): Promise<void>;
  setEnabled(selector: string, enabled: boolean): Promise<void>;
}

export interface OrcaProject {
  readonly id: string;
  readonly name?: string;
  readonly absolutePath: string;
}

interface ProjectMetadata {
  readonly aliases?: readonly string[];
  readonly enabled?: boolean;
  readonly sensitivePaths?: readonly string[];
  readonly setupPolicy?: SetupPolicy;
  readonly defaultBaseRef?: string;
}

interface CatalogMetadata {
  readonly version: 1;
  readonly projects: Readonly<Record<string, ProjectMetadata>>;
}

export interface ProjectCatalogOptions {
  readonly directory: string;
  readonly legacyRegistryPath?: string;
  readonly defaultSensitivePaths?: readonly string[];
  readonly isBusy?: (id: string) => boolean | Promise<boolean>;
  readonly discover?: () => Promise<readonly OrcaProject[]>;
  readonly addToOrca?: (absolutePath: string) => Promise<OrcaProject>;
}

const mutationQueues = new Map<string, Promise<void>>();

async function mutate<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  mutationQueues.set(key, tail);
  try {
    return await result;
  } finally {
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key);
  }
}

function normalizedSelector(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function requiredText(value: unknown, error: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(error);
  return value.trim();
}

function normalizedAbsolutePath(value: unknown): string {
  const path = requiredText(value, "orca_project_invalid_path");
  if (!isAbsolute(path) || path.includes("\0") || path.length > MAX_PATH_LENGTH) {
    throw new Error("orca_project_invalid_path");
  }
  return normalize(path);
}

function orcaExecutable(): string {
  const configured = process.env.ORCA_CLI_COMMAND?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  if (process.env.ORCA_DEV_REPO_ROOT !== undefined) return "orca-dev";
  return platform() === "linux" ? "orca-ide" : "orca";
}

function parseOrcaProject(value: unknown): OrcaProject {
  if (typeof value !== "object" || value === null) throw new Error("orca_project_invalid");
  const record = value as Record<string, unknown>;
  const id = requiredText(record.id, "orca_project_invalid_id");
  const absolutePath = normalizedAbsolutePath(record.path ?? record.absolutePath);
  const rawName = record.displayName ?? record.name;
  return {
    id,
    ...(typeof rawName === "string" && rawName.trim().length > 0 ? { name: rawName.trim() } : {}),
    absolutePath
  };
}

async function defaultDiscover(): Promise<readonly OrcaProject[]> {
  const result = await execute(orcaExecutable(), ["repo", "list", "--json"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const response = JSON.parse(result.stdout) as {
    readonly ok?: boolean;
    readonly result?: { readonly repos?: readonly unknown[] };
  };
  if (response.ok !== true || !Array.isArray(response.result?.repos)) {
    throw new Error("orca_project_discovery_failed");
  }
  return response.result.repos.map(parseOrcaProject);
}

async function defaultAddToOrca(absolutePath: string): Promise<OrcaProject> {
  const result = await execute(orcaExecutable(), ["repo", "add", "--path", absolutePath, "--json"], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024
  });
  const response = JSON.parse(result.stdout) as {
    readonly ok?: boolean;
    readonly result?: unknown;
  };
  if (response.ok !== true || typeof response.result !== "object" || response.result === null) {
    throw new Error("orca_project_add_failed");
  }
  const payload = response.result as Record<string, unknown>;
  return parseOrcaProject(payload.repo ?? payload);
}

function emptyMetadata(): CatalogMetadata {
  return { version: 1, projects: {} };
}

function parseMetadata(value: unknown): CatalogMetadata {
  if (typeof value !== "object" || value === null) throw new Error("project_metadata_invalid");
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || typeof document.projects !== "object" || document.projects === null || Array.isArray(document.projects)) {
    throw new Error("project_metadata_invalid");
  }
  const projects: Record<string, ProjectMetadata> = {};
  for (const [id, raw] of Object.entries(document.projects as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("project_metadata_invalid");
    const record = raw as Record<string, unknown>;
    if (record.aliases !== undefined && (!Array.isArray(record.aliases) || record.aliases.some(alias => typeof alias !== "string" || alias.trim().length === 0))) {
      throw new Error("project_metadata_invalid");
    }
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error("project_metadata_invalid");
    const setupPolicy = record.setupPolicy;
    if (setupPolicy !== undefined && setupPolicy !== "run" && setupPolicy !== "skip" && setupPolicy !== "inherit") {
      throw new Error("project_metadata_invalid");
    }
    projects[id] = {
      ...(record.aliases === undefined ? {} : { aliases: [...record.aliases as string[]] }),
      ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
      ...(Array.isArray(record.sensitivePaths) && record.sensitivePaths.every(path => typeof path === "string")
        ? { sensitivePaths: [...record.sensitivePaths as string[]] }
        : {}),
      ...(setupPolicy === undefined ? {} : { setupPolicy }),
      ...(typeof record.defaultBaseRef === "string" && record.defaultBaseRef.trim().length > 0
        ? { defaultBaseRef: record.defaultBaseRef }
        : {})
    };
  }
  return { version: 1, projects };
}

async function readMetadata(path: string): Promise<CatalogMetadata> {
  try {
    return parseMetadata(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMetadata();
    throw error;
  }
}

async function writeMetadata(directory: string, path: string, metadata: CatalogMetadata): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${METADATA_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function legacyByProject(
  legacyRegistryPath: string | undefined
): Map<string, ProjectRegistryEntry> {
  if (legacyRegistryPath === undefined) return new Map();
  let entries: readonly ProjectRegistryEntry[];
  try {
    entries = Registry.read(legacyRegistryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(entries.map(entry => [entry.orcaProjectId, entry]));
}

function managedProject(
  project: OrcaProject,
  metadata: ProjectMetadata | undefined,
  legacy: ProjectRegistryEntry | undefined,
  defaultSensitivePaths: readonly string[]
): ManagedProject {
  const absolutePath = normalizedAbsolutePath(project.absolutePath);
  const name = project.name?.trim() || legacy?.projectKey || basename(absolutePath);
  const defaultBaseRef = metadata?.defaultBaseRef ?? legacy?.defaultBaseRef;
  const aliases = [legacy?.projectKey, ...(metadata?.aliases ?? legacy?.aliases ?? [])]
    .filter((value): value is string => value !== undefined)
    .filter((value, index, values) =>
      ![project.id, name].some(identity => normalizedSelector(identity) === normalizedSelector(value))
      && values.findIndex(candidate => normalizedSelector(candidate) === normalizedSelector(value)) === index);
  const sensitivePaths = [...defaultSensitivePaths, ...(metadata?.sensitivePaths ?? legacy?.sensitivePaths ?? [])]
    .map(path => requiredText(path, "project_sensitive_path_invalid"))
    .filter((path, index, paths) => paths.indexOf(path) === index);
  return {
    id: project.id,
    name,
    absolutePath,
    aliases,
    enabled: metadata?.enabled ?? true,
    sensitivePaths,
    setupPolicy: metadata?.setupPolicy ?? legacy?.setupPolicy ?? "inherit",
    ...(defaultBaseRef === undefined ? {} : { defaultBaseRef })
  };
}

function selectorMatches(project: ManagedProject, selector: string): boolean {
  const normalized = normalizedSelector(selector);
  return [project.id, project.name, ...project.aliases]
    .some(candidate => normalizedSelector(candidate) === normalized);
}

function resolveFrom(projects: readonly ManagedProject[], selector: string): ManagedProject {
  if (normalizedSelector(selector).length === 0) throw new Error("project_selector_empty");
  const matches = projects.filter(project => selectorMatches(project, selector));
  if (matches.length === 0) throw new Error(`project_not_found:${selector}`);
  if (matches.length > 1) {
    throw new Error(`project_selector_ambiguous:${selector}:${matches.map(project => project.id).join(",")}`);
  }
  return matches[0]!;
}

async function canonicalGitPath(path: string): Promise<string> {
  const supplied = requiredText(path, "project_path_empty");
  if (!isAbsolute(supplied)) throw new Error("project_path_not_absolute");
  const candidate = resolve(supplied);
  if (candidate.includes("\0") || candidate.length > MAX_PATH_LENGTH) throw new Error("project_path_invalid");
  try {
    const result = await execute("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024
    });
    return normalizedAbsolutePath(result.stdout.trim());
  } catch {
    throw new Error(`project_path_not_git:${candidate}`);
  }
}

export function createProjectCatalog(options: ProjectCatalogOptions): ProjectCatalog {
  const directory = normalizedAbsolutePath(resolve(options.directory));
  const metadataPath = join(directory, METADATA_FILE);
  const discover = options.discover ?? defaultDiscover;
  const addToOrca = options.addToOrca ?? defaultAddToOrca;
  const isBusy = options.isBusy ?? (() => false);
  const defaultSensitivePaths = options.defaultSensitivePaths ?? [];

  async function list(): Promise<ManagedProject[]> {
    const raw = await discover();
    const ids = new Set<string>();
    const paths = new Set<string>();
    const discovered = raw.map(project => {
      const normalized = parseOrcaProject(project);
      if (ids.has(normalized.id)) throw new Error(`orca_project_duplicate_id:${normalized.id}`);
      if (paths.has(normalized.absolutePath)) throw new Error(`orca_project_duplicate_path:${normalized.absolutePath}`);
      ids.add(normalized.id);
      paths.add(normalized.absolutePath);
      return normalized;
    });
    const [metadata, legacy] = await Promise.all([
      readMetadata(metadataPath),
      Promise.resolve(legacyByProject(options.legacyRegistryPath))
    ]);
    return discovered.map(project => managedProject(
      project,
      metadata.projects[project.id],
      legacy.get(project.id),
      defaultSensitivePaths
    ));
  }

  async function guard(project: ManagedProject): Promise<void> {
    if (await isBusy(project.id)) throw new Error(`project_busy:${project.id}`);
  }

  return {
    list,
    resolve: async selector => resolveFrom(await list(), selector),
    add: async path => mutate(metadataPath, async () => {
      const absolutePath = await canonicalGitPath(path);
      const current = await list();
      const existing = current.find(project => project.absolutePath === absolutePath);
      if (existing !== undefined) return existing;
      const added = parseOrcaProject(await addToOrca(absolutePath));
      if (added.absolutePath !== absolutePath) throw new Error("orca_project_added_path_mismatch");
      return managedProject(added, undefined, undefined, defaultSensitivePaths);
    }),
    alias: async (selector, alias) => mutate(metadataPath, async () => {
      const projects = await list();
      const project = resolveFrom(projects, selector);
      await guard(project);
      const normalized = normalizedSelector(alias);
      if (normalized.length === 0) throw new Error("project_alias_empty");
      const collisions = projects.filter(candidate => candidate.id !== project.id && selectorMatches(candidate, alias));
      if (collisions.length > 0) throw new Error(`project_alias_conflict:${alias}:${collisions.map(value => value.id).join(",")}`);
      if ([project.id, project.name, ...project.aliases].some(value => normalizedSelector(value) === normalized)) return;
      const metadata = await readMetadata(metadataPath);
      await writeMetadata(directory, metadataPath, {
        version: 1,
        projects: {
          ...metadata.projects,
          [project.id]: {
            ...metadata.projects[project.id],
            aliases: [...project.aliases, alias.trim()]
          }
        }
      });
    }),
    setEnabled: async (selector, enabled) => mutate(metadataPath, async () => {
      const project = resolveFrom(await list(), selector);
      await guard(project);
      if (project.enabled === enabled) return;
      const metadata = await readMetadata(metadataPath);
      await writeMetadata(directory, metadataPath, {
        version: 1,
        projects: {
          ...metadata.projects,
          [project.id]: { ...metadata.projects[project.id], enabled }
        }
      });
    })
  };
}
