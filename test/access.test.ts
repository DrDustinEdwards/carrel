// Planted problems for the gate. Every refusal case must be a bare 403 and must never reach render.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { gate } from "../workers/gate";
import { addPerson, resetDb, testEnv } from "./env";

const ISSUER = "https://test-team.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

let keys: ReturnType<typeof createLocalJWKSet>;
let signingKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const stranger = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  strangerKey = stranger.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("gone@test.invalid", { disabled: true });
});

type Claims = { email?: string; iss?: string; aud?: string; exp?: number };

async function token(claims: Claims = {}, key: CryptoKey = signingKey): Promise<string> {
  const { email = "owner@test.invalid", iss = ISSUER, aud = AUDIENCE, exp } = claims;
  const jwt = new SignJWT(email ? { email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt();
  jwt.setExpirationTime(exp ?? "5m");
  return jwt.sign(key);
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

  it("refuses an empty token", async () => {
    await expectRefused(request(""));
  });

  it("refuses a token that is not a JWT", async () => {
    await expectRefused(request("not-a-jwt"));
  });

  it("refuses a token signed by a key the team does not publish", async () => {
    await expectRefused(request(await token({}, strangerKey)));
  });

  it("refuses the wrong audience", async () => {
    await expectRefused(request(await token({ aud: "some-other-app" })));
  });

  it("refuses the wrong issuer", async () => {
    await expectRefused(request(await token({ iss: "https://other-team.cloudflareaccess.com" })));
  });

  it("refuses an expired token", async () => {
    await expectRefused(request(await token({ exp: Math.floor(Date.now() / 1000) - 3600 })));
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

  it("refuses everyone when ACCESS_AUD is not set", async () => {
    await expectRefused(request(await token()), { ...testEnv, ACCESS_AUD: "" });
  });

  it("refuses everyone when the team domain is not set", async () => {
    await expectRefused(request(await token()), { ...testEnv, ACCESS_TEAM_DOMAIN: "" });
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

  it("accepts the team domain written with a trailing slash", async () => {
    const env = { ...testEnv, ACCESS_TEAM_DOMAIN: `${ISSUER}/` };
    const { response } = await run(request(await token()), env);
    expect(response.status).toBe(200);
  });
});
