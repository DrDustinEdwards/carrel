import { refuseNetwork } from "@dustinedwards/devkit/network";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

import { testEnv } from "./env";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_D1_MIGRATIONS);
});

// Nothing in these tests may reach the network. A test that needs a response installs its own.
beforeEach(() => refuseNetwork());
