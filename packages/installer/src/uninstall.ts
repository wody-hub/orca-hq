import { isAbsolute, normalize, parse, relative } from "node:path";

import { assertNoActiveWork, type GatewayUpdateStatus } from "./update.js";

export interface UninstallPaths {
  readonly program: string;
  readonly data: string;
  readonly database: string;
}

export interface UninstallContext {
  readonly paths: UninstallPaths;
  readonly protectedPaths?: readonly string[];
  readonly gateway: Readonly<{
    status(): Promise<GatewayUpdateStatus>;
  }>;
  readonly launchd: Readonly<{
    uninstall(): Promise<void>;
  }>;
  readonly files: Readonly<{
    removeProgram(path: string): Promise<void>;
    removeData(path: string): Promise<void>;
  }>;
}

export interface UninstallOptions {
  readonly removeData: boolean;
  readonly confirmation?: string;
}

export interface UninstallResult {
  readonly dataPreserved: boolean;
  readonly removedProgramPath: string;
  readonly removedDataPath?: string;
}

export class UninstallConfirmationError extends Error {
  readonly code = "confirmation_required" as const;
  readonly expectedPhrase: string;

  constructor(expectedPhrase: string) {
    super("Exact path-specific confirmation is required for uninstall.");
    this.name = "UninstallConfirmationError";
    this.expectedPhrase = expectedPhrase;
  }
}

function safePath(path: string, label: string): string {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  if (!isAbsolute(normalized) || normalized === root || normalize(parse(normalized).dir) === root
    || /[\u0000\r\n]/u.test(normalized)) {
    throw new TypeError(`${label} must be a specific absolute path.`);
  }
  return normalized;
}

function inside(child: string, parent: string): boolean {
  const candidate = relative(parent, child);
  return candidate !== "" && candidate !== ".." && !candidate.startsWith(`..${parse(child).root === "\\" ? "\\" : "/"}`)
    && !isAbsolute(candidate);
}

/** Returns the exact phrase required for the configured destructive data-removal path. */
export function programRemovalConfirmationPhrase(programPath: string): string {
  return `REMOVE ORCA HQ PROGRAM AT ${safePath(programPath, "Program path")}`;
}

/** Returns the stronger exact phrase required to remove both program and durable data. */
export function dataRemovalConfirmationPhrase(programPath: string, dataPath: string): string {
  return `${programRemovalConfirmationPhrase(programPath)} AND DATA AT ${safePath(dataPath, "Data path")}`;
}

/** Removes service/program state while preserving Application Support data unless separately confirmed. */
export function createUninstall(context: UninstallContext): Readonly<{
  readonly programPath: string;
  readonly dataPath: string;
  readonly programConfirmationPhrase: string;
  readonly dataConfirmationPhrase: string;
  run(options: UninstallOptions): Promise<UninstallResult>;
}> {
  const program = safePath(context.paths.program, "Program path");
  const data = safePath(context.paths.data, "Data path");
  const database = safePath(context.paths.database, "Database path");
  const protectedPaths = (context.protectedPaths ?? []).map((path) => safePath(path, "Protected path"));
  const overlapsProtected = (path: string): boolean => protectedPaths.some(
    (protectedPath) => path === protectedPath || inside(protectedPath, path)
  );
  if (program === data || inside(data, program) || inside(program, data) || !inside(database, data)
    || overlapsProtected(program) || overlapsProtected(data)) {
    throw new TypeError("Program and durable data paths are not safely separated.");
  }

  return Object.freeze({
    programPath: program,
    dataPath: data,
    programConfirmationPhrase: programRemovalConfirmationPhrase(program),
    dataConfirmationPhrase: dataRemovalConfirmationPhrase(program, data),
    async run(options): Promise<UninstallResult> {
      await assertNoActiveWork(context);
      const expected = options.removeData
        ? dataRemovalConfirmationPhrase(program, data)
        : programRemovalConfirmationPhrase(program);
      if (options.confirmation !== expected) throw new UninstallConfirmationError(expected);

      await context.launchd.uninstall();
      await context.files.removeProgram(program);
      if (!options.removeData) {
        return Object.freeze({ dataPreserved: true, removedProgramPath: program });
      }
      await context.files.removeData(data);
      return Object.freeze({
        dataPreserved: false,
        removedProgramPath: program,
        removedDataPath: data
      });
    }
  });
}
