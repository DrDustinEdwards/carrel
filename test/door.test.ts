// The two doors (design decision 7, corrected 2026-09-27). The browser door is carrel.dustinedwards.info
// behind Access; the AI door is carrel-mcp.dustinedwards.info, an OAuth authorization server of its
// own with Cloudflare Access for SaaS as the sign-in. They are told apart by hostname, never by email.
//
// The AI door is driven end to end here: a CIMD client, the consent page, Access's sign-in (a fake
// Access for SaaS: its token and keys endpoints, answered through the stubbed fetch), the token
// endpoint, and a tool call with the token. Each planted refusal must end without a grant.

import { createExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiDoor, isMcpHost } from "~/lib/mcp/door";

import { gate } from "../workers/gate";
import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { MCP_HOST, modernRequest, readMessage, type ToolCallResult } from "./mcp-client";
import { connectedEnv, fakeSite } from "./site";

const TEAM = "https://test-team.cloudflareaccess.com";
const BROWSER_AUD = "test-audience-tag";
const SAAS_CLIENT = "carrel-saas-client";
const SAAS_ISSUER = `${TEAM}/cdn-cgi/access/sso/oidc/${SAAS_CLIENT}`;
const DOOR = `https://${MCP_HOST}`;
const CLIENT_ID = "https://client.test/oauth/claude-code.json";
const REDIRECT = "https://client.test/callback";
const RESOURCE = `${DOOR}/mcp`;
const VERIFIER = "the-mcp-clients-own-pkce-verifier-0123456789abcdefghij";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "access", alg: "RS256", use: "sig" }] };
});

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("reviewer@test.invalid", { reviewer: true });
  await addPerson("gone@test.invalid", { disabled: true });
});

const doorEnv = (): Env => ({ ...testEnv, ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret" });

// ---------- the browser door

function accessToken(aud: string, email = "owner@test.invalid", key = signingKey) {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "access" }).setIssuer(TEAM).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(key);
}

async function browser(path: string, jwt: string) {
  let rendered = false;
  const response = await gate(
    new Request(`https://carrel.test${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
    testEnv,
    async () => {
      rendered = true;
      return new Response("inside");
    },
    createLocalJWKSet(jwks),
  );
  return { status: response.status, rendered };
}

describe("the browser door", () => {
  it("lets the browser's Access token in", async () => {
    expect(await browser("/", await accessToken(BROWSER_AUD))).toEqual({ status: 200, rendered: true });
  });

  it("PLANT: a token from any other Access application is refused, the retired MCP Access app's included", async () => {
    expect(await browser("/", await accessToken("test-mcp-audience-tag"))).toEqual({ status: 403, rendered: false });
  });

  it("PLANT: a reviewer is refused at the browser door", async () => {
    expect(await browser("/", await accessToken(BROWSER_AUD, "reviewer@test.invalid"))).toEqual({ status: 403, rendered: false });
  });

  it("PLANT: /mcp on the browser's host is a page behind Access like any other, never the AI door", async () => {
    expect(isMcpHost(new Request("https://carrel.test/mcp"), testEnv)).toBe(false);
    expect(await browser("/mcp", "")).toEqual({ status: 403, rendered: false });
  });
});

describe("which door", () => {
  it("is decided by the hostname alone", () => {
    expect(isMcpHost(new Request(`${DOOR}/mcp`), testEnv)).toBe(true);
    expect(isMcpHost(new Request(`${DOOR}/p/x/e/y`), testEnv)).toBe(true);
    expect(isMcpHost(new Request(`https://CARREL-MCP.test/mcp`), testEnv)).toBe(true);
    for (const url of ["https://carrel.test/mcp", "https://carrel-mcp.test.evil.example/mcp", "https://evil.example/carrel-mcp.test/mcp", "http://carrel-mcp.test:8443/mcp"]) {
      expect(isMcpHost(new Request(url), testEnv), url).toBe(false);
    }
  });
});

// ---------- the AI door

type Jar = Map<string, string>;

function remember(jar: Jar, response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const at = pair!.indexOf("=");
    jar.set(pair!.slice(0, at), pair!.slice(at + 1));
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function s256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type IdClaims = { email?: string; nonce?: string; aud?: string; iss?: string; key?: CryptoKey; email_verified?: boolean };

/** The fake Access for SaaS (and the client's CIMD document), behind the stubbed fetch. */
function fakeAccess(claims: (nonce: string) => IdClaims) {
  let nonce = "";
  const seen: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(`${request.method} ${request.url}`);
    if (request.url === CLIENT_ID) {
      return Response.json({
        client_id: CLIENT_ID,
        client_name: "Claude Code",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    if (request.url === `${SAAS_ISSUER}/jwks`) return Response.json(jwks);
    if (request.url === `${SAAS_ISSUER}/token` && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_secret") !== "saas-secret" || form.get("code") !== "access-code" || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const c = claims(nonce);
      const jwt = new SignJWT({ email: c.email ?? "owner@test.invalid", nonce: c.nonce ?? nonce, ...(c.email_verified === undefined ? {} : { email_verified: c.email_verified }) })
        .setProtectedHeader({ alg: "RS256", kid: "access" })
        .setIssuer(c.iss ?? SAAS_ISSUER)
        .setAudience(c.aud ?? SAAS_CLIENT)
        .setIssuedAt()
        .setExpirationTime("5m");
      return Response.json({ id_token: await jwt.sign(c.key ?? signingKey), access_token: "access-access-token", token_type: "Bearer" });
    }
    throw new Error(`the fake Access does not answer ${request.method} ${request.url}`);
  });
  return { fetch, seen, setNonce: (n: string) => (nonce = n) };
}

async function door(request: Request, env: Env = doorEnv()) {
  return aiDoor(request, env, createExecutionContext());
}

/**
 * Walks the whole sign-in. Returns the final redirect to the client (with a code, or an error), and
 * the Access authorization URL the browser was sent to.
 */
async function signIn(claims: (nonce: string) => IdClaims = () => ({}), opts: { decision?: "approve" | "deny"; accessError?: boolean } = {}) {
  const access = fakeAccess(claims);
  vi.stubGlobal("fetch", access.fetch);
  const jar: Jar = new Map();
  const authorize = new URL(`${DOOR}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    state: "client-state",
    code_challenge: await s256(VERIFIER),
    code_challenge_method: "S256",
    scope: "carrel",
    resource: RESOURCE,
  }).toString();
  const page = await door(new Request(authorize));
  expect(page.status, await page.clone().text()).toBe(200);
  remember(jar, page);
  const html = await page.text();
  expect(html).toContain("Allow Claude Code to use Carrel as you?");
  expect(html).toContain("client.test");
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;

  const approve = await door(
    new Request(`${DOOR}/authorize`, {
      method: "POST",
      headers: { Cookie: cookieHeader(jar), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: opts.decision ?? "approve" }),
    }),
  );
  expect(approve.status).toBe(302);
  remember(jar, approve);
  const toAccess = new URL(approve.headers.get("Location")!);
  if (opts.decision === "deny") return { final: toAccess, toAccess: null, access };

  expect(toAccess.origin + toAccess.pathname).toBe(`${SAAS_ISSUER}/authorization`);
  access.setNonce(toAccess.searchParams.get("nonce")!);
  const back = new URL(`${DOOR}/callback`);
  back.searchParams.set("state", toAccess.searchParams.get("state")!);
  if (opts.accessError) back.searchParams.set("error", "access_denied");
  else back.searchParams.set("code", "access-code");
  const done = await door(new Request(back, { headers: { Cookie: cookieHeader(jar) } }));
  expect(done.status).toBe(302);
  return { final: new URL(done.headers.get("Location")!), toAccess, access };
}

async function tokenFor(code: string): Promise<string> {
  const response = await door(
    new Request(`${DOOR}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: VERIFIER, resource: RESOURCE }),
    }),
  );
  const body = (await response.json()) as { access_token?: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.access_token!;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}, env?: Env): Promise<{ status: number; result?: ToolCallResult }> {
  const response = await door(modernRequest(7, "tools/call", { name, arguments: args }, { Authorization: `Bearer ${token}` }), env);
  if (response.status !== 200) return { status: response.status };
  return { status: 200, result: (await readMessage(response)).result as unknown as ToolCallResult };
}

describe("the AI door's OAuth surface", () => {
  it("answers /mcp without a token with a Bearer challenge that points at its metadata", async () => {
    const response = await door(modernRequest(1, "tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${DOOR}/.well-known/oauth-protected-resource/mcp"`);
    const meta = (await (await door(new Request(`${DOOR}/.well-known/oauth-protected-resource/mcp`))).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ resource: RESOURCE, authorization_servers: [DOOR] });
  });

  it("advertises CIMD and no registration endpoint, and /register does not exist", async () => {
    const meta = (await (await door(new Request(`${DOOR}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBeUndefined();
    const register = await door(new Request(`${DOOR}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) }));
    expect(register.status).toBe(404);
  });

  it("PLANT: never serves Carrel's pages", async () => {
    for (const path of ["/", "/p/de-info", "/p/de-info/e/post-one/unpublish", "/social"]) {
      expect((await door(new Request(`${DOOR}${path}`))).status, path).toBe(404);
    }
  });

  it("PLANT: stays shut until the Access for SaaS app is configured", async () => {
    const response = await door(new Request(`${DOOR}/authorize?client_id=${encodeURIComponent(CLIENT_ID)}`), testEnv);
    expect(response.status).toBe(503);
  });
});

describe("signing in through Access for SaaS", () => {
  it("an Owner signs in, and the grant reaches the tools as that person, credited to the client", async () => {
    const { final, toAccess } = await signIn();
    expect(toAccess!.searchParams.get("client_id")).toBe(SAAS_CLIENT);
    expect(toAccess!.searchParams.get("redirect_uri")).toBe(`${DOOR}/callback`);
    expect(toAccess!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(final.origin + final.pathname).toBe(REDIRECT);
    expect(final.searchParams.get("state")).toBe("client-state");
    const token = await tokenFor(final.searchParams.get("code")!);

    await addProject("de-info", "dustinedwards");
    const { result } = await callTool(token, "list_projects");
    expect(result!.structuredContent).toMatchObject({ projects: [{ slug: "de-info", role: "owner" }] });

    // The client is credited by its CIMD name on what it writes.
    const site = fakeSite();
    await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: One\n---\nWords.\n", expectedVersion: null, changeId: "seed" });
    const env = connectedEnv({ ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret" });
    vi.stubGlobal("fetch", site.fetch);
    await callTool(token, "add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env);
    expect(await testEnv.DB.prepare("SELECT message FROM findings").first()).toEqual({ message: "A flag. (from Claude Code)" });
  });

  it("PLANT: Access let someone in whom Carrel does not know: refused, no code", async () => {
    const { final } = await signIn(() => ({ email: "stranger@test.invalid" }));
    expect(final.searchParams.get("error")).toBe("access_denied");
    expect(final.searchParams.get("error_description")).toBe("This person is not in Carrel.");
    expect(final.searchParams.get("code")).toBeNull();
  });

  it("PLANT: a disabled person is refused at sign-in", async () => {
    const { final } = await signIn(() => ({ email: "gone@test.invalid" }));
    expect(final.searchParams.get("error")).toBe("access_denied");
  });

  it("PLANT: an ID token with the wrong nonce, the wrong audience, a foreign key or an unverified email is refused", async () => {
    for (const claims of [
      { nonce: "replayed" },
      { aud: "some-other-saas-app" },
      { iss: `${TEAM}/cdn-cgi/access/sso/oidc/other` },
      { key: otherKey },
      { email_verified: false },
    ] satisfies IdClaims[]) {
      const { final } = await signIn(() => claims);
      expect(final.searchParams.get("error"), JSON.stringify(claims)).toBe("access_denied");
      expect(final.searchParams.get("code")).toBeNull();
    }
  });

  it("PLANT: Access reporting an error, and a person who clicks Deny, end with access_denied", async () => {
    expect((await signIn(undefined, { accessError: true })).final.searchParams.get("error")).toBe("access_denied");
    const denied = await signIn(undefined, { decision: "deny" });
    expect(denied.final.searchParams.get("error")).toBe("access_denied");
    expect(denied.access.seen.some((s) => s.includes("/token"))).toBe(false);
  });

  it("PLANT: a person disabled after the grant loses the door at once", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    expect((await callTool(token, "list_projects")).status).toBe(200);
    await testEnv.DB.prepare("UPDATE people SET disabled_at = '2026-09-27T00:00:00Z' WHERE email = 'owner@test.invalid'").run();
    expect((await callTool(token, "list_projects")).status).toBe(403);
  });

  it("PLANT: a grant follows the person, not the email: the email moved to a new person row is refused", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    expect((await callTool(token, "list_projects")).status).toBe(200);
    // The same email, now a different person (the row was replaced): the old grant must not carry over.
    await testEnv.DB.prepare("UPDATE people SET id = id + 1000 WHERE email = 'owner@test.invalid'").run();
    expect((await callTool(token, "list_projects")).status).toBe(403);
  });

  it("PLANT: a reviewer signs in through the same door and is refused a publish", async () => {
    const { final } = await signIn(() => ({ email: "reviewer@test.invalid" }));
    const token = await tokenFor(final.searchParams.get("code")!);
    const id = await addProject("de-info", "dustinedwards");
    const reviewer = await testEnv.DB.prepare("SELECT id FROM people WHERE email = 'reviewer@test.invalid'").first<{ id: number }>();
    await share(id, reviewer!.id, "reader");
    const { result } = await callTool(token, "publish", { project: "de-info", item: "post-one", expected_version: "v1" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "A reviewer never publishes." }] });
  });

  it("PLANT: a forged or foreign bearer token is refused", async () => {
    expect((await callTool("not-a-token", "list_projects")).status).toBe(401);
    expect((await callTool(await accessToken(BROWSER_AUD), "list_projects")).status).toBe(401);
  });
});
