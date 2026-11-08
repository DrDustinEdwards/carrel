// What the monthly API cap counts: the picture suggester's calls, which report no tokens, and an episode claim left by a pass
// that died before saving a draft.

import { beforeEach, describe, expect, it } from "vitest";

import { monthSpendMicros, recordForeignCall } from "~/lib/ai-engine.server";
import { freeDeadClaim } from "~/lib/episode-drafts.server";
import { d1FireStore } from "~/lib/social/routine.server";

import { resetDb, testEnv } from "./env";

beforeEach(resetDb);

describe("alt-text calls in the cap", () => {
  it("count at the suggester's ceiling, and a model with no listed price counts at the dearest price", async () => {
    const env = testEnv;
    await recordForeignCall(env, "alt", "claude-haiku-5-5");
    const listed = await monthSpendMicros(env.DB);
    expect(listed).toBeGreaterThan(0);
    await recordForeignCall(env, "alt", "claude-unlisted");
    expect((await monthSpendMicros(env.DB)) - listed).toBeGreaterThan(listed);
  });
});

describe("a claim left by a pass that died", () => {
  it("is freed once it is older than the lease and no API draft exists", async () => {
    const env = testEnv;
    const store = d1FireStore(env.DB);
    const now = new Date("2026-11-08T12:00:00Z");
    await store.add("api-episode-draft:x:10", "2026-11-08T11:00:00.000Z");
    await store.add("api-episode-draft:y:10", "2026-11-08T11:59:00.000Z");
    await freeDeadClaim(env.DB, store, "api-episode-draft:x:10", "x", now);
    await freeDeadClaim(env.DB, store, "api-episode-draft:y:10", "y", now);
    expect(await store.get("api-episode-draft:x:10")).toBeNull();
    expect(await store.get("api-episode-draft:y:10")).not.toBeNull();
  });
});
