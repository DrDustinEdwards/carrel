import { refuseNetwork } from "@dustinedwards/devkit/network";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach } from "vitest";

import { testEnv } from "./env";
import { roomsSaved } from "./room-saves";

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_D1_MIGRATIONS);
});

// Nothing in these tests may reach the network. A test that needs a response installs its own.
beforeEach(() => refuseNetwork());

// A room's debounced save lands before the next test clears the tables (test/room-saves.ts).
afterEach(() => roomsSaved());
