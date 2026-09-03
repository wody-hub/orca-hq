import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRedactedField, redactDeep, type RedactionOptions } from "./redaction.js";

export interface DiagnosticCreateInput extends RedactionOptions {
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly schema: string;
  readonly health: unknown;
  readonly counters: Readonly<Record<string, number>>;
  readonly auditReferences: readonly string[];
  readonly includeFullContent: false;
  readonly stagingRoot?: string;
}

export interface DiagnosticManifest {
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly schema: string;
  readonly health: unknown;
  readonly counters: Readonly<Record<string, number>>;
  readonly auditReferences: readonly string[];
  readonly files: readonly ["manifest.json"];
}

export interface DiagnosticBundle {
  readonly stagingPath: string;
  readonly manifest: DiagnosticManifest;
  text(): string;
}

function removeFullContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeFullContent);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !isRedactedField(key))
        .map(([key, entry]) => [key, removeFullContent(entry)])
    );
  }
  return value;
}

function aggregateCounters(counters: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(counters).filter(([, value]) => Number.isFinite(value) && value >= 0)
  ));
}

export function createPilotCounters(initial: Readonly<Record<string, number>> = {}): {
  increment(name: string, amount?: number): void;
  snapshot(): Readonly<Record<string, number>>;
} {
  const counters = new Map<string, number>();
  for (const [name, value] of Object.entries(initial)) {
    if (Number.isFinite(value) && value >= 0) counters.set(name, value);
  }
  return {
    increment(name, amount = 1) {
      if (!Number.isFinite(amount) || amount <= 0) return;
      counters.set(name, (counters.get(name) ?? 0) + amount);
    },
    snapshot() {
      return Object.freeze(Object.fromEntries(counters));
    }
  };
}

export async function create(input: DiagnosticCreateInput): Promise<DiagnosticBundle> {
  const manifest: DiagnosticManifest = Object.freeze({
    version: input.version,
    capabilities: Object.freeze([...input.capabilities]),
    schema: input.schema,
    health: removeFullContent(redactDeep(input.health, input)),
    counters: aggregateCounters(input.counters),
    auditReferences: Object.freeze([...input.auditReferences]),
    files: Object.freeze(["manifest.json"] as ["manifest.json"])
  });
  const text = JSON.stringify(manifest, null, 2);
  const stagingPath = input.stagingRoot === undefined
    ? await mkdtemp(join(tmpdir(), "orca-hq-diagnostics-"))
    : await mkdtemp(join(input.stagingRoot, "orca-hq-diagnostics-"));

  await mkdir(stagingPath, { recursive: true });
  await writeFile(join(stagingPath, "manifest.json"), text, "utf8");

  return Object.freeze({
    stagingPath,
    manifest,
    text: () => text
  });
}

export const diagnostics = Object.freeze({ create });
