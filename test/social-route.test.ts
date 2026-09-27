// The social page through its loader and action: the Owner's alone, and an account added there
// starts off, in approval mode.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { action as socialAction, loader as socialLoader } from "~/routes/social";

import { addPerson, addProject, resetDb, testEnv } from "./env";
import { viewerFor } from "./site";

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("editor@test.invalid");
  await addProject("germomics", "dustinedwards");
});

async function context(email: string) {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, { env: testEnv, ctx: {} as ExecutionContext });
  c.set(viewerContext, await viewerFor(email));
  c.set(nonceContext, "n");
  return c;
}

describe("the social page", () => {
  it("PLANT: is 404 to anyone but the Owner", async () => {
    await expect(socialLoader({ request: new Request("https://carrel.test/social"), params: {}, context: await context("editor@test.invalid") } as never)).rejects.toMatchObject({ status: 404 });
  });

  it("adds an account that starts off, in approval mode, and says the routine is not set up", async () => {
    const body = new FormData();
    for (const [k, v] of Object.entries({ intent: "add-account", key: "germomics-bluesky", name: "Germomics", platform: "bluesky", kind: "brand", handle: "@germomics.bsky.social" })) body.set(k, v);
    expect(await socialAction({ request: new Request("https://carrel.test/social", { method: "POST", body }), params: {}, context: await context("owner@test.invalid") } as never)).toEqual({ ok: true });
    const data = (await socialLoader({ request: new Request("https://carrel.test/social"), params: {}, context: await context("owner@test.invalid") } as never)) as Awaited<ReturnType<typeof socialLoader>>;
    expect(data.accounts).toMatchObject([{ key: "germomics-bluesky", handle: "germomics.bsky.social", enabled: false, mode: "approval" }]);
    expect(data.routine).toBe("SOCIAL_ROUTINE_URL and SOCIAL_ROUTINE_TOKEN are not both set.");
  });
});
