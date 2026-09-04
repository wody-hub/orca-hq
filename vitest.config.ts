import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

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
    alias: {
      "@orca-hq/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@orca-hq/orca-adapter": fileURLToPath(
        new URL("./packages/orca-adapter/src/index.ts", import.meta.url)
      ),
      "@orca-hq/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url)
      ),
      "@orca-hq/persistence": fileURLToPath(
        new URL("./packages/persistence/src/index.ts", import.meta.url)
      ),
      "@orca-hq/project-registry": fileURLToPath(
        new URL("./packages/project-registry/src/index.ts", import.meta.url)
      ),
      "@orca-hq/tailscale-adapter": fileURLToPath(
        new URL("./packages/tailscale-adapter/src/index.ts", import.meta.url)
      ),
      "@orca-hq/voice": fileURLToPath(new URL("./packages/voice/src/index.ts", import.meta.url)),
      "@orca-hq/worker-routing": fileURLToPath(
        new URL("./packages/worker-routing/src/index.ts", import.meta.url)
      )
    }
  }
});
