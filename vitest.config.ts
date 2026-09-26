import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Real workerd with local D1, migrated from the same drizzle/ files a deploy applies, so the tests
// never carry a second copy of the schema.
const D1_MIGRATIONS = await readD1Migrations(fileURLToPath(new URL("./drizzle", import.meta.url)));

export default defineConfig({
  resolve: {
    alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) }],
  },
  plugins: [
    cloudflareTest({
      main: "./test/entry.ts",
      miniflare: {
        compatibilityDate: "2026-09-01",
        d1Databases: ["DB"],
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-audience-tag",
          ALERT_EMAIL: "owner@test.invalid",
          ALERT_FROM: "carrel@test.invalid",
          SITE_DUSTINEDWARDS_ORIGIN: "https://site.test",
          TEST_D1_MIGRATIONS: D1_MIGRATIONS,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
