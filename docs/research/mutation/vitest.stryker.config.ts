import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The repo's vitest config, minus the tests that read raw source text (Stryker's rewriting breaks
// them). Paths resolve from the project root, which is where Stryker runs it.
const root = process.cwd();
const D1_MIGRATIONS = await readD1Migrations(`${root}/drizzle`);

export default defineConfig({
  root,
  resolve: {
    alias: [{ find: /^~\//, replacement: `${root}/app/` }],
  },
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-10-02",
        compatibilityFlags: ["global_fetch_strictly_public"],
        d1Databases: ["DB"],
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-audience-tag",
          ALERT_EMAIL: "owner@test.invalid",
          ALERT_FROM: "carrel@test.invalid",
          SITE_DUSTINEDWARDS_ORIGIN: "https://site.test",
          CARREL_MCP_ORIGIN: "https://carrel-mcp.test",
          TEST_D1_MIGRATIONS: D1_MIGRATIONS,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/wrangler-config.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
