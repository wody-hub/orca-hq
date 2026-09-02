import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from "node:path";

import { z } from "zod";

const NonBlankStringSchema = z.string().trim().min(1);
const AbsolutePathSchema = NonBlankStringSchema.refine(isAbsolute, "must be an absolute path");
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactIdSchema = z.string().regex(/^assignment:[a-f0-9]{64}$/u);

export const AssignmentArtifactReferenceSchema = z.object({
  protocol: z.literal(1),
  artifactId: ArtifactIdSchema,
  path: AbsolutePathSchema
}).strict();

export const AssignmentArtifactSchema = AssignmentArtifactReferenceSchema.extend({
  version: z.number().int().positive(),
  ownerDispatchId: NonBlankStringSchema,
  content: z.string().min(1),
  sha256: Sha256Schema
}).strict();

export const AssignmentArtifactStageInputSchema = z.object({
  reference: AssignmentArtifactReferenceSchema,
  version: z.number().int().positive(),
  ownerDispatchId: NonBlankStringSchema,
  content: z.string().min(1)
}).strict();

export type AssignmentArtifactReference = Readonly<
  z.infer<typeof AssignmentArtifactReferenceSchema>
>;
export type AssignmentArtifact = Readonly<z.infer<typeof AssignmentArtifactSchema>>;
export type AssignmentArtifactStageInput = Readonly<
  z.infer<typeof AssignmentArtifactStageInputSchema>
>;
export type AssignmentArtifactCleanupResult = "removed" | "missing" | "superseded";

export interface AssignmentArtifactStore {
  referenceFor(taskId: string): AssignmentArtifactReference;
  stage(input: AssignmentArtifactStageInput): Promise<AssignmentArtifact>;
  cleanup(artifact: AssignmentArtifact): Promise<AssignmentArtifactCleanupResult>;
}

export class AssignmentArtifactVersionConflictError extends Error {
  readonly code = "assignment_artifact_version_conflict";
  readonly retryable = false;

  constructor() {
    super("Assignment artifact version is not newer than the current version");
    this.name = "AssignmentArtifactVersionConflictError";
  }
}

export class AssignmentArtifactRootUnsafeError extends Error {
  readonly code = "assignment_artifact_root_unsafe";
  readonly retryable = false;

  constructor() {
    super("Assignment artifact root is not a private owned directory");
    this.name = "AssignmentArtifactRootUnsafeError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class FileAssignmentArtifactStore implements AssignmentArtifactStore {
  readonly #rootDirectory: string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: Readonly<{ rootDirectory: string }>) {
    if (!isAbsolute(options.rootDirectory)) {
      throw new TypeError("assignment artifact rootDirectory must be absolute");
    }
    const requestedRoot = resolve(options.rootDirectory);
    this.#rootDirectory = join(realpathSync(dirname(requestedRoot)), basename(requestedRoot));
  }

  referenceFor(taskIdValue: string): AssignmentArtifactReference {
    const taskId = NonBlankStringSchema.parse(taskIdValue);
    const digest = sha256(taskId);
    return Object.freeze(AssignmentArtifactReferenceSchema.parse({
      protocol: 1,
      artifactId: `assignment:${digest}`,
      path: join(this.#rootDirectory, `${digest}.json`)
    }));
  }

  async stage(inputValue: AssignmentArtifactStageInput): Promise<AssignmentArtifact> {
    const input = AssignmentArtifactStageInputSchema.parse(inputValue);
    this.#assertOwnedReference(input.reference);
    return this.#exclusive(input.reference.path, async () => {
      const current = await this.#read(input.reference.path);
      if (current !== undefined && current.version >= input.version) {
        throw new AssignmentArtifactVersionConflictError();
      }
      const artifact = Object.freeze(AssignmentArtifactSchema.parse({
        ...input.reference,
        version: input.version,
        ownerDispatchId: input.ownerDispatchId,
        content: input.content,
        sha256: sha256(input.content)
      }));
      await this.#replace(artifact);
      return artifact;
    });
  }

  async cleanup(artifactValue: AssignmentArtifact): Promise<AssignmentArtifactCleanupResult> {
    const artifact = AssignmentArtifactSchema.parse(artifactValue);
    this.#assertOwnedReference(artifact);
    return this.#exclusive(artifact.path, async () => {
      await this.#ensureRoot();
      const current = await this.#read(artifact.path);
      if (current === undefined) return "missing";
      if (
        current.artifactId !== artifact.artifactId
        || current.version !== artifact.version
        || current.ownerDispatchId !== artifact.ownerDispatchId
        || current.sha256 !== artifact.sha256
        || current.content !== artifact.content
      ) return "superseded";
      await unlink(artifact.path);
      await this.#syncDirectory();
      return "removed";
    });
  }

  #assertOwnedReference(reference: AssignmentArtifactReference): void {
    const digest = reference.artifactId.slice("assignment:".length);
    if (
      resolve(dirname(reference.path)) !== this.#rootDirectory
      || basename(reference.path) !== `${digest}.json`
    ) {
      throw new TypeError("assignment artifact reference is outside its store");
    }
  }

  async #read(path: string): Promise<AssignmentArtifact | undefined> {
    try {
      return AssignmentArtifactSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async #replace(artifact: AssignmentArtifact): Promise<void> {
    await this.#ensureRoot();
    const temporaryPath = join(
      this.#rootDirectory,
      `.${basename(artifact.path)}.${randomUUID()}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(artifact), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, artifact.path);
      await this.#syncDirectory();
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }

  async #ensureRoot(): Promise<void> {
    try {
      await mkdir(this.#rootDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const root = await lstat(this.#rootDirectory);
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !root.isDirectory()
      || root.isSymbolicLink()
      || (root.mode & 0o077) !== 0
      || (expectedUid !== undefined && root.uid !== expectedUid)
    ) {
      throw new AssignmentArtifactRootUnsafeError();
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#rootDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async #exclusive<Result>(path: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.#queues.set(path, tail);
    try {
      return await current;
    } finally {
      if (this.#queues.get(path) === tail) this.#queues.delete(path);
    }
  }
}
