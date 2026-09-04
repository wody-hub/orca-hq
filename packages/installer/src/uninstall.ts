import { isAbsolute, normalize, parse, relative } from "node:path";

export interface UninstallPaths {
  readonly program: string;
  readonly data: string;
  readonly database: string;
}

export interface UninstallContext {
  readonly paths: UninstallPaths;
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
    super("Exact path-specific confirmation is required to remove user data.");
    this.name = "UninstallConfirmationError";
    this.expectedPhrase = expectedPhrase;
  }
}

function safePath(path: string, label: string): string {
  const normalized = normalize(path);
  if (!isAbsolute(normalized) || normalized === parse(normalized).root) {
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
export function dataRemovalConfirmationPhrase(dataPath: string): string {
  return `REMOVE ORCA HQ DATA AT ${safePath(dataPath, "Data path")}`;
}

/** Removes service/program state while preserving Application Support data unless separately confirmed. */
export function createUninstall(context: UninstallContext): Readonly<{
  run(options: UninstallOptions): Promise<UninstallResult>;
}> {
  const program = safePath(context.paths.program, "Program path");
  const data = safePath(context.paths.data, "Data path");
  const database = safePath(context.paths.database, "Database path");
  if (program === data || inside(data, program) || inside(program, data) || !inside(database, data)) {
    throw new TypeError("Program and durable data paths are not safely separated.");
  }

  return Object.freeze({
    async run(options): Promise<UninstallResult> {
      if (options.removeData) {
        const expected = dataRemovalConfirmationPhrase(data);
        if (options.confirmation !== expected) throw new UninstallConfirmationError(expected);
      }

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
