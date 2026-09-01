import { readFileSync } from "node:fs";

import { parse } from "yaml";

import {
  DiscoveredProjectSchema,
  ProjectRegistryDocumentSchema,
  type DiscoveredProject,
  type ProjectRegistryEntry
} from "./schema.js";

function normalizeAlias(alias: string): string {
  return alias.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function assertUniqueAliases(entries: readonly ProjectRegistryEntry[]): void {
  const projectKeyByAlias = new Map<string, string>();

  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const normalized = normalizeAlias(alias);
      const existingProjectKey = projectKeyByAlias.get(normalized);
      if (existingProjectKey !== undefined) {
        throw new Error(`duplicate alias '${alias}' for projects '${existingProjectKey}' and '${entry.projectKey}'`);
      }
      projectKeyByAlias.set(normalized, entry.projectKey);
    }
  }
}

function assertApprovedImports(
  entries: readonly ProjectRegistryEntry[],
  discoveredProjects: readonly DiscoveredProject[]
): void {
  const discoveredByOrcaProjectId = new Map<string, DiscoveredProject>();
  for (const project of discoveredProjects) {
    if (discoveredByOrcaProjectId.has(project.orcaProjectId)) {
      throw new Error(`duplicate imported Orca project '${project.orcaProjectId}'`);
    }
    discoveredByOrcaProjectId.set(project.orcaProjectId, project);
  }

  for (const entry of entries) {
    const discovered = discoveredByOrcaProjectId.get(entry.orcaProjectId);
    if (discovered === undefined) {
      throw new Error(`registry project '${entry.projectKey}' was not imported from Orca`);
    }
    if (!discovered.approved) {
      throw new Error(`imported Orca project '${entry.orcaProjectId}' is not approved`);
    }
    if (discovered.absolutePath !== entry.absolutePath) {
      throw new Error(`registry project '${entry.projectKey}' does not match the approved imported path`);
    }
  }
}

export class Registry {
  static load(path: string, discoveredProjects: readonly DiscoveredProject[] = []): ProjectRegistryEntry[] {
    const document = ProjectRegistryDocumentSchema.parse(parse(readFileSync(path, "utf8")));
    const discovered = DiscoveredProjectSchema.array().parse(discoveredProjects);

    assertUniqueAliases(document.projects);
    assertApprovedImports(document.projects, discovered);

    return document.projects;
  }
}

export { normalizeAlias };
