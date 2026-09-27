// The Google routes through their loaders: manuscripts and Connect Google are the Owner's, and the
// OAuth round trip runs through the real route with the fake Google behind it.

import { RouterContextProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { clearSaTokenCache } from "~/lib/google/service-account.server";
import { loader as authLoader } from "~/routes/auth.google";
import { loader as homeLoader } from "~/routes/home";
import { loader as manuscriptsLoader } from "~/routes/manuscripts";

import { addPerson, resetDb, testEnv } from "./env";
import { CODE, fakeGoogle, serviceAccountKey } from "./google";
import { viewerFor } from "./site";

let key: Awaited<ReturnType<typeof serviceAccountKey>>;
beforeAll(async () => {
  key = await serviceAccountKey();
});

let env: Env;
beforeEach(async () => {
  clearSaTokenCache();
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("editor@test.invalid");
  vi.stubGlobal("fetch", fakeGoogle({ publicJwk: key.publicJwk }).fetch);
  env = {
    ...testEnv,
    GOOGLE_SA_KEY: key.json,
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    GOOGLE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    GOOGLE_MANUSCRIPTS_FOLDER_ID: "folderRoot1",
  } as Env;
});

async function context(email: string) {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  c.set(viewerContext, await viewerFor(email));
  c.set(nonceContext, "n");
  return c;
}

async function settle<T>(p: Promise<T>): Promise<T | Response> {
  try {
    return await p;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe("Google routes", () => {
  it("PLANT: manuscripts and Connect Google are 404 to anyone but the Owner", async () => {
    const req = new Request("https://carrel.test/manuscripts");
    expect(((await settle(manuscriptsLoader({ request: req, params: {}, context: await context("editor@test.invalid") } as never))) as Response).status).toBe(404);
    const start = new Request("https://carrel.test/auth/google/start");
    expect(((await settle(authLoader({ request: start, params: { step: "start" }, context: await context("editor@test.invalid") } as never))) as Response).status).toBe(404);
    const home = (await homeLoader({ request: new Request("https://carrel.test/"), params: {}, context: await context("editor@test.invalid") } as never)) as Awaited<ReturnType<typeof homeLoader>>;
    expect(home.google).toBeNull();
  });

  it("connects Google through the real routes and says so on the home page", async () => {
    const owner = await context("owner@test.invalid");
    const start = (await authLoader({ request: new Request("https://carrel.test/auth/google/start"), params: { step: "start" }, context: owner } as never)) as Response;
    const google = new URL(start.headers.get("Location")!);
    expect(google.hostname).toBe("accounts.google.com");
    const back = new Request(`https://carrel.test/auth/google/callback?state=${google.searchParams.get("state")}&code=${encodeURIComponent(CODE)}`);
    const done = (await authLoader({ request: back, params: { step: "callback" }, context: await context("owner@test.invalid") } as never)) as Response;
    const message = new URL(done.headers.get("Location")!, "https://carrel.test").searchParams.get("google");
    expect(message).toBe("Google is connected for Send to Docs and Import (drive.file only).");
    const home = (await homeLoader({ request: new Request("https://carrel.test/"), params: {}, context: await context("owner@test.invalid") } as never)) as Awaited<ReturnType<typeof homeLoader>>;
    expect(home.google).toEqual({ configured: true, connected: true });
  });

  it("shows the manuscripts page with the setup still missing, rather than failing", async () => {
    env = { ...env, GOOGLE_SA_KEY: undefined } as Env;
    const data = (await manuscriptsLoader({ request: new Request("https://carrel.test/manuscripts?q=x"), params: {}, context: await context("owner@test.invalid") } as never)) as Awaited<
      ReturnType<typeof manuscriptsLoader>
    >;
    expect(data.setup).toMatch(/^GOOGLE_SA_KEY is not set/);
    expect(data.files).toEqual([]);
  });
});
