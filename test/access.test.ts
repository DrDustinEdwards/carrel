// Planted problems for the gate. Every refusal case must be a bare 403 and must never reach render.

import { stubAccess } from "@dustinedwards/devkit/access";
import type { KeySource } from "@dustinedwards/site-runtime/access-login";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import routes from "../app/routes";
import { gate } from "../workers/gate";
import { DESK_PATTERNS, routeOf } from "../workers/route";
import { addPerson, localKeys, resetDb, testEnv } from "./env";

const ISSUER = "https://test-team.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

const stub = (email = "owner@test.invalid") => stubAccess({ issuer: ISSUER, audience: AUDIENCE, email, install: false });

let keys: KeySource;
let team: Awaited<ReturnType<typeof stub>>;
let stranger: Awaited<ReturnType<typeof stub>>;

beforeAll(async () => {
  team = await stub();
  // A second stub signs with a key the team does not publish.
  stranger = await stub();
  keys = localKeys(team.jwk);
});

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("gone@test.invalid", { disabled: true });
});

type Claims = { email?: string; iss?: string; aud?: string; exp?: number };

function token(claims: Claims = {}, signer = team): Promise<string> {
  return signer.token(claims);
}

function request(jwt?: string): Request {
  const headers = new Headers();
  if (jwt !== undefined) headers.set("Cf-Access-Jwt-Assertion", jwt);
  return new Request("https://carrel.test/", { headers });
}

async function run(req: Request, env: Env = testEnv) {
  let rendered = false;
  const response = await gate(req, env, async () => {
    rendered = true;
    return new Response("inside");
  }, keys);
  return { response, rendered };
}

async function expectRefused(req: Request, env?: Env) {
  const { response, rendered } = await run(req, env);
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("Forbidden");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(rendered).toBe(false);
}

describe("gate: refusals (fail closed)", () => {
  it("refuses a request with no Access token", async () => {
    await expectRefused(request());
  });

  it("refuses a token signed by a key the team does not publish", async () => {
    await expectRefused(request(await token({}, stranger)));
  });

  it("refuses the wrong audience", async () => {
    await expectRefused(request(await token({ aud: "some-other-app" })));
  });

  it("refuses a valid token with no email", async () => {
    await expectRefused(request(await token({ email: "" })));
  });

  it("refuses an email Access admitted but Carrel does not know", async () => {
    await expectRefused(request(await token({ email: "stranger@test.invalid" })));
  });

  it("refuses a disabled person", async () => {
    await expectRefused(request(await token({ email: "gone@test.invalid" })));
  });

  it("refuses a signed-in POST sent from another site's page", async () => {
    const req = request(await token());
    await expectRefused(new Request("https://carrel.test/p/x/bulk", { method: "POST", headers: { ...Object.fromEntries(req.headers), Origin: "https://evil.example.com" } }));
  });

  it("refuses everyone when ACCESS_AUD is not set", async () => {
    await expectRefused(request(await token()), { ...testEnv, ACCESS_AUD: "" });
  });

});

describe("gate: admission", () => {
  it("admits a valid token for a known person and passes the viewer to render", async () => {
    let seen = "";
    const response = await gate(request(await token()), testEnv, async (_req, viewer) => {
      seen = viewer.email;
      return new Response("inside");
    }, keys);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("inside");
    expect(seen).toBe("owner@test.invalid");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("leaves an HTML page untransformed so Web Analytics cannot inject its beacon, and no asset", async () => {
    const through = async (type: string) =>
      gate(request(await token()), testEnv, async () => new Response("x", { headers: { "Content-Type": type } }), keys);
    for (const html of ["text/html; charset=utf-8", "TEXT/HTML"]) {
      expect((await through(html)).headers.get("cache-control")).toBe("private, no-store, no-transform");
    }
    for (const asset of ["text/css", "text/javascript", "font/woff2", "application/json", "text/plain; charset=utf-8"]) {
      expect((await through(asset)).headers.get("cache-control"), asset).toBe("private, no-store");
    }
  });

  it("matches the email without regard to case", async () => {
    const { response } = await run(request(await token({ email: "Owner@Test.Invalid" })));
    expect(response.status).toBe(200);
  });

});

// Desk's one public path (area 8, H1), and the log's route names (workers/route.ts, L3) kept in step with app/routes.ts.
describe("gate: /health and route names", () => {
  it("answers the shared health with the deployed commit, with no Access token and without rendering", async () => {
    const { response, rendered } = await run(new Request("https://carrel.test/health"), { ...testEnv, DEPLOY_SHA: "abcdef1" } as Env);
    expect(rendered).toBe(false);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.json()).toMatchObject({ sha: "abcdef1" });
  });

  it("names every route app/routes.ts declares, and a path no route has stays unnamed", () => {
    type Entry = { path?: string; index?: boolean; children?: Entry[] };
    const paths = (list: Entry[]): string[] => list.flatMap((r) => [...(r.index ? ["/"] : r.path ? [`/${r.path}`] : []), ...paths(r.children ?? [])]);
    expect([...DESK_PATTERNS].sort()).toEqual(paths(routes as Entry[]).sort());
    expect(routeOf(new Request("https://carrel.test/p/sample/e/42"))).toBe("/p/:project/e/:item");
    expect(routeOf(new Request("https://carrel.test/wp-login.php"))).toBeUndefined();
  });
});
