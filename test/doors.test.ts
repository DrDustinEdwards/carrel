// Planted problems for the two doors (design decision 2a): a browser session is never treated as AI,
// and an AI session never as a browser. The door is the Access application that signed the token,
// checked by its audience, never the person's email.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { gate, type Door } from "../workers/gate";
import { addPerson, resetDb, testEnv } from "./env";

const ISSUER = "https://test-team.cloudflareaccess.com";
const BROWSER_AUD = "test-audience-tag";
const MCP_AUD = "test-mcp-audience-tag";

let keys: ReturnType<typeof createLocalJWKSet>;
let signingKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("reviewer@test.invalid", { reviewer: true });
});

function token(aud: string, email = "owner@test.invalid") {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(signingKey);
}

const env = { ...testEnv, ACCESS_MCP_AUD: MCP_AUD };

async function through(path: string, jwt: string, e: Env = env) {
  let door: Door | null = null;
  const response = await gate(
    new Request(`https://carrel.test${path}`, { method: path === "/mcp" ? "POST" : "GET", headers: { "Cf-Access-Jwt-Assertion": jwt } }),
    e,
    async (_req, _viewer, d) => {
      door = d;
      return new Response("inside");
    },
    keys,
  );
  return { status: response.status, door: door as Door | null };
}

describe("the two doors", () => {
  it("lets the browser's token in at the browser door, as browser", async () => {
    expect(await through("/", await token(BROWSER_AUD))).toEqual({ status: 200, door: "browser" });
    expect(await through("/p/x/e/y", await token(BROWSER_AUD))).toEqual({ status: 200, door: "browser" });
  });

  it("lets the MCP application's token in at /mcp, as AI", async () => {
    expect(await through("/mcp", await token(MCP_AUD))).toEqual({ status: 200, door: "ai" });
  });

  it("PLANT: a browser session at /mcp is refused, never treated as AI", async () => {
    expect(await through("/mcp", await token(BROWSER_AUD))).toEqual({ status: 403, door: null });
  });

  it("PLANT: an AI session anywhere but /mcp is refused, never treated as a browser", async () => {
    for (const path of ["/", "/p/x/e/y", "/p/x/e/y/unpublish", "/mcp/", "/mcp/extra", "/MCP"]) {
      expect(await through(path, await token(MCP_AUD)), path).toEqual({ status: 403, door: null });
    }
  });

  it("PLANT: the AI door is shut until ACCESS_MCP_AUD is set, and shut if it is the browser's own AUD", async () => {
    expect(await through("/mcp", await token(MCP_AUD), { ...testEnv })).toEqual({ status: 403, door: null });
    const same = { ...testEnv, ACCESS_MCP_AUD: BROWSER_AUD };
    expect(await through("/mcp", await token(BROWSER_AUD), same)).toEqual({ status: 403, door: null });
  });

  it("the person's email plays no part in which door it is", async () => {
    // The same person, both doors, told apart only by the application that signed the token.
    expect((await through("/", await token(BROWSER_AUD, "owner@test.invalid"))).door).toBe("browser");
    expect((await through("/mcp", await token(MCP_AUD, "owner@test.invalid"))).door).toBe("ai");
  });

  it("PLANT: a reviewer is refused at the browser door and let in at the AI door", async () => {
    expect(await through("/", await token(BROWSER_AUD, "reviewer@test.invalid"))).toEqual({ status: 403, door: null });
    expect(await through("/mcp", await token(MCP_AUD, "reviewer@test.invalid"))).toEqual({ status: 200, door: "ai" });
  });
});
