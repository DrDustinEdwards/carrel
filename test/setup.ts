import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, vi } from "vitest";

import { testEnv } from "./env";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_D1_MIGRATIONS);
});

// Nothing in these tests may reach the network. A test that needs a response installs its own.
beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`the tests do not reach the network, and something asked for ${url}`);
  });
});
