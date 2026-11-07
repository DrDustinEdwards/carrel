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
        compatibilityDate: "2026-10-02",
        // As wrangler.jsonc: the AI door's OAuth provider needs the flag to fetch CIMD documents.
        compatibilityFlags: ["global_fetch_strictly_public"],
        d1Databases: ["DB"],
        kvNamespaces: ["OAUTH_KV"],
        r2Buckets: ["BACKUPS"],
        // As wrangler.jsonc: a file's live room and the AI door's limiter and call log, exported by
        // test/entry.ts as the real entry exports them.
        durableObjects: {
          DOC_ROOM: { className: "DocRoom", useSQLite: true },
          MCP_RATE_LIMIT: { className: "RateLimiter", useSQLite: true },
          TOOL_CALL_LOG: { className: "ToolCallLog", useSQLite: true },
        },
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-audience-tag",
          ADMIN_EMAIL: "owner@test.invalid",
          ALERT_EMAIL: "owner@test.invalid",
          ALERT_FROM: "carrel@test.invalid",
          SITE_DUSTINEDWARDS_ORIGIN: "https://site.test",
          CARREL_MCP_ORIGIN: "https://carrel-mcp.test",
          TEST_D1_MIGRATIONS: D1_MIGRATIONS,
          // A fake key for the tool-call log's signatures (site-runtime 0.85 requires one).
          AUDIT_SIGNING_KEY: "test-signing-key-not-a-real-one-0123456789",
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
