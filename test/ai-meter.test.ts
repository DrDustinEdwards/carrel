// The AI meter records each API call's prompt size. One-hour cache writes are counted apart from five-minute ones in
// site-runtime's usage, so a meter that sums only cacheWrite under-reports a prompt that was cached for an hour.

import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it } from "vitest";

import { aiUsage } from "~/db/schema";
import { meteredOptions } from "~/lib/ai-engine.server";

import { resetDb, testEnv } from "./env";

beforeEach(resetDb);

it("PLANT: prompt size counts input, cache reads, and both five-minute and one-hour cache writes", async () => {
  const options = meteredOptions(testEnv, "social", "high");
  await options.onResult?.({
    model: "claude-opus-5-5",
    ok: true,
    input: 100,
    output: 50,
    cacheRead: 1000,
    cacheWrite: 200,
    cacheWrite1h: 3000,
  } as Parameters<NonNullable<typeof options.onResult>>[0]);
  const rows = await drizzle(testEnv.DB).select().from(aiUsage);
  expect(rows.map((r) => [r.promptSize, r.answerSize, r.effort])).toEqual([[4300, 50, "high"]]);
});
