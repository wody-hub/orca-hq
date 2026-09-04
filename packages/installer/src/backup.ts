import { basename, isAbsolute, join } from "node:path";

export interface BackupReceipt {
  readonly id: string;
  readonly path: string;
  readonly databasePath: string;
  readonly configPath?: string;
  readonly createdAt: string;
  readonly sourceRevision: string;
  readonly schemaVersion: number;
  readonly includesConfig: boolean;
  readonly includesSecrets: false;
}

export interface BackupCreateOptions {
  readonly includeConfig: boolean;
  readonly includeSecrets: false;
}

export interface BackupRestoreOptions {
  readonly includeConfig: boolean;
  readonly includeSecrets: false;
}

export interface BackupOperations {
  createOnlineBackup(options: BackupCreateOptions): Promise<BackupReceipt>;
  restore(receipt: BackupReceipt, options: BackupRestoreOptions): Promise<void>;
}

export interface BackupServicePorts {
  readonly paths: Readonly<{
    backupDirectory: string;
    configPath?: string;
  }>;
  readonly database: Readonly<{
    backupTo(destination: string): Promise<void>;
    restoreFrom(source: string): Promise<void>;
  }>;
  readonly files: Readonly<{
    createDirectory(path: string): Promise<void>;
    copyFile(source: string, destination: string): Promise<void>;
    writeText(path: string, text: string): Promise<void>;
  }>;
  readonly metadata: Readonly<{
    schemaVersion(): Promise<number>;
    sourceRevision(): Promise<string>;
  }>;
  readonly now?: () => Date;
}

function backupError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function validatePaths(ports: BackupServicePorts): void {
  if (!isAbsolute(ports.paths.backupDirectory)) {
    throw new TypeError("The backup directory must be an absolute path.");
  }
  if (ports.paths.configPath !== undefined && !isAbsolute(ports.paths.configPath)) {
    throw new TypeError("The configuration path must be an absolute path.");
  }
}

function backupId(date: Date): string {
  const iso = date.toISOString();
  return iso.replaceAll(":", "-").replace(".", "-");
}

function assertSecretFree(options: { readonly includeSecrets: boolean }): void {
  if (options.includeSecrets !== false) {
    throw backupError("secrets_forbidden", "Backup archives cannot include secrets.");
  }
}

/** Coordinates SQLite's online backup API with an optional secret-free config snapshot. */
export function createBackupService(ports: BackupServicePorts): BackupOperations {
  validatePaths(ports);
  return Object.freeze({
    async createOnlineBackup(options: BackupCreateOptions): Promise<BackupReceipt> {
      assertSecretFree(options);
      if (options.includeConfig && ports.paths.configPath === undefined) {
        throw backupError("config_path_missing", "A configuration path is required for this backup.");
      }

      const createdAt = (ports.now ?? (() => new Date()))().toISOString();
      const id = backupId(new Date(createdAt));
      const path = join(ports.paths.backupDirectory, id);
      const databasePath = join(path, "runtime.sqlite");
      const configPath = options.includeConfig ? join(path, basename(ports.paths.configPath!)) : undefined;
      const [schemaVersion, sourceRevision] = await Promise.all([
        ports.metadata.schemaVersion(),
        ports.metadata.sourceRevision()
      ]);
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || sourceRevision.length === 0) {
        throw backupError("backup_metadata_invalid", "Backup metadata is unavailable.");
      }

      const receipt: BackupReceipt = Object.freeze({
        id,
        path,
        databasePath,
        ...(configPath === undefined ? {} : { configPath }),
        createdAt,
        sourceRevision,
        schemaVersion,
        includesConfig: options.includeConfig,
        includesSecrets: false
      });

      await ports.files.createDirectory(path);
      await ports.database.backupTo(databasePath);
      if (configPath !== undefined) {
        await ports.files.copyFile(ports.paths.configPath!, configPath);
      }
      await ports.files.writeText(join(path, "manifest.json"), `${JSON.stringify(receipt, null, 2)}\n`);
      return receipt;
    },

    async restore(receipt: BackupReceipt, options: BackupRestoreOptions): Promise<void> {
      assertSecretFree(options);
      if (options.includeConfig && (receipt.configPath === undefined || ports.paths.configPath === undefined)) {
        throw backupError("config_backup_missing", "The requested configuration backup is unavailable.");
      }
      await ports.database.restoreFrom(receipt.databasePath);
      if (options.includeConfig) {
        await ports.files.copyFile(receipt.configPath!, ports.paths.configPath!);
      }
    }
  });
}
