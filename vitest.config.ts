import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceRoot = dirname(fileURLToPath(import.meta.url));
const tsconfig = JSON.parse(readFileSync(resolve(workspaceRoot, "tsconfig.json"), "utf8")) as {
  readonly compilerOptions: {
    readonly paths: Readonly<Record<string, readonly string[]>>;
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const workspaceSourceAliases = Object.entries(tsconfig.compilerOptions.paths).map(
  ([specifier, targets]) => {
    const [target] = targets;
    if (target === undefined) throw new Error(`No source target configured for ${specifier}`);
    const wildcardIndex = specifier.indexOf("*");
    if (wildcardIndex < 0) {
      return {
        find: new RegExp(`^${escapeRegExp(specifier)}$`),
        replacement: resolve(workspaceRoot, target)
      };
    }
    if (specifier.indexOf("*", wildcardIndex + 1) >= 0 || target.split("*").length !== 2) {
      throw new Error(`Unsupported workspace source path pattern: ${specifier} -> ${target}`);
    }
    return {
      find: new RegExp(
        `^${escapeRegExp(specifier.slice(0, wildcardIndex))}(.+)${escapeRegExp(specifier.slice(wildcardIndex + 1))}$`
      ),
      replacement: resolve(workspaceRoot, target.replace("*", "$1"))
    };
  }
);

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "orca-hq",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
            "tests/{e2e,chaos}/**/*.spec.ts"
          ]
        }
      },
      {
        extends: true,
        test: {
          name: "orca-hq-web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "jsdom"
        }
      }
    ]
  },
  resolve: {
    alias: workspaceSourceAliases
  }
});
