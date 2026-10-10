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

import { aiDoor, apiHandler, isMcpHost } from "~/lib/mcp/door";
import { ALL_PER_DAY, PER_ADDRESS_PER_HOUR } from "~/lib/mcp/registration";

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
async function signIn(
  claims: (nonce: string) => IdClaims = () => ({}),
  opts: { decision?: "approve" | "deny" | "read-only"; accessError?: boolean; scope?: string; resource?: string } = {},
) {
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
    scope: opts.scope ?? "carrel:read carrel:write",
    resource: opts.resource ?? RESOURCE,
  }).toString();
  const page = await door(new Request(authorize));
  expect(page.status, await page.clone().text()).toBe(200);
  // The consent page is HTML: untransformed, so Web Analytics cannot inject its beacon into it.
  expect(page.headers.get("cache-control")).toBe("no-store, no-transform");
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

  it("advertises CIMD, the tightened registration endpoint, and the two scopes", async () => {
    const meta = (await (await door(new Request(`${DOOR}/.well-known/oauth-authorization-server`))).json()) as Record<string, unknown>;
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBe(`${DOOR}/register`);
    expect(meta.scopes_supported).toEqual(["carrel:read", "carrel:write"]);
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
    const { result } = await callTool(token, "carrel_list_projects");
    expect(result!.structuredContent).toMatchObject({ projects: [{ slug: "de-info", role: "owner" }] });

    // The client is credited by its CIMD name on what it writes.
    const site = fakeSite();
    await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: One\n---\nWords.\n", expectedVersion: null, changeId: "seed" });
    const env = connectedEnv({ ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret" });
    vi.stubGlobal("fetch", site.fetch);
    await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env);
    expect(await testEnv.DB.prepare("SELECT message FROM findings").first()).toEqual({ message: "A flag. (from Claude Code)" });
  });

  it("PLANT: OAuth is unchanged while an agent key is configured: the grant is still the person, an Owner here, never an agent", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    await addProject("de-info", "dustinedwards");
    await addPerson("agent:grok");
    const withKey = connectedEnv({ ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret", AGENT_KEY_GROK: "grok-test-key-0123456789abcdefghijklmnop" });
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const { status, result } = await callTool(token, "carrel_list_projects", {}, withKey);
    expect(status).toBe(200);
    expect(result!.structuredContent).toMatchObject({ projects: [{ slug: "de-info", role: "owner" }] });
    await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, withKey);
    expect(await testEnv.DB.prepare("SELECT message FROM findings").first()).toEqual({ message: "A flag. (from Claude Code)" });
    // And a token that is not a grant is still refused by the provider, not read as an agent key.
    expect((await callTool("not-a-token", "carrel_list_projects", {}, withKey)).status).toBe(401);
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
    expect((await callTool(token, "carrel_list_projects")).status).toBe(200);
    await testEnv.DB.prepare("UPDATE people SET disabled_at = '2026-09-27T00:00:00Z' WHERE email = 'owner@test.invalid'").run();
    expect((await callTool(token, "carrel_list_projects")).status).toBe(403);
  });

  it("PLANT: a grant follows the person, not the email: the email moved to a new person row is refused", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    expect((await callTool(token, "carrel_list_projects")).status).toBe(200);
    // The same email, now a different person (the row was replaced): the old grant must not carry over.
    await testEnv.DB.prepare("UPDATE people SET id = id + 1000 WHERE email = 'owner@test.invalid'").run();
    expect((await callTool(token, "carrel_list_projects")).status).toBe(403);
  });

  it("PLANT: a reviewer signs in through the same door and is refused a publish", async () => {
    const { final } = await signIn(() => ({ email: "reviewer@test.invalid" }));
    const token = await tokenFor(final.searchParams.get("code")!);
    const id = await addProject("de-info", "dustinedwards");
    const reviewer = await testEnv.DB.prepare("SELECT id FROM people WHERE email = 'reviewer@test.invalid'").first<{ id: number }>();
    await share(id, reviewer!.id, "reader");
    const { result } = await callTool(token, "carrel_publish_item", { project: "de-info", item: "post-one", expected_version: "v1" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "A reviewer never publishes." }] });
  });

  it("PLANT: a forged or foreign bearer token is refused", async () => {
    expect((await callTool("not-a-token", "carrel_list_projects")).status).toBe(401);
    expect((await callTool(await accessToken(BROWSER_AUD), "carrel_list_projects")).status).toBe(401);
  });
});

// ---------- tightened registration (ruling 2026-10-10, rule 13)

const GROK_CALLBACK = "https://grok.com/connectors/oauth/callback";
let address = 0;

/** A registration from its own address unless one is given, so the per-address limit never leaks between tests. */
function register(body: Record<string, unknown>, from = `198.51.100.${(address += 1)}`) {
  return door(new Request(`${DOOR}/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": from }, body: JSON.stringify(body) }));
}

const dayKey = () => `dcr-rate:all:${Math.floor(Date.now() / 86_400_000)}`;

describe("tightened registration", () => {
  beforeEach(async () => {
    await testEnv.OAUTH_KV.delete(dayKey());
  });

  it("registers a client whose callbacks are all on the allowlist, and the registration grants nothing", async () => {
    const response = await register({ client_name: "Grok", redirect_uris: [GROK_CALLBACK], token_endpoint_auth_method: "none" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.redirect_uris).toEqual([GROK_CALLBACK]);
    // No token, no scope, no grant: a client id and nothing it can use on its own.
    expect(body.access_token).toBeUndefined();
    expect(body.scope).toBeUndefined();
    expect((await callTool(String(body.client_id), "carrel_list_projects")).status).toBe(401);
    const machine = await door(
      new Request(`${DOOR}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: String(body.client_id) }) }),
    );
    expect(machine.status).toBe(400);
  });

  it("PLANT: a callback off the allowlist, a prefix of one, a pattern or localhost is refused", async () => {
    for (const uri of ["https://evil.example/callback", `${GROK_CALLBACK}/x`, "https://grok.com/connectors/oauth/callback?next=https://evil.example", "http://127.0.0.1:3000/callback", "https://grok.com/"]) {
      const response = await register({ redirect_uris: [uri] });
      expect(response.status, uri).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    // One bad callback among good ones spoils the registration.
    expect((await register({ redirect_uris: [GROK_CALLBACK, "https://evil.example/callback"] })).status).toBe(400);
  });

  it("an exact callback added in DCR_REDIRECT_URIS is allowed, and only that one", async () => {
    const extra = "https://chatgpt.com/connector/oauth/abc123";
    const env = { ...doorEnv(), DCR_REDIRECT_URIS: `${extra} http://insecure.example/cb` } as Env;
    const ok = await door(new Request(`${DOOR}/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.200" }, body: JSON.stringify({ redirect_uris: [extra] }) }), env);
    expect(ok.status).toBe(201);
    for (const uri of [`${extra}x`, "http://insecure.example/cb"]) {
      const refused = await door(new Request(`${DOOR}/register`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.201" }, body: JSON.stringify({ redirect_uris: [uri] }) }), env);
      expect(refused.status, uri).toBe(400);
    }
  });

  it("a client asking for a grant beyond the code and refresh grants is refused (by the provider)", async () => {
    expect((await register({ redirect_uris: [GROK_CALLBACK], grant_types: ["authorization_code", "client_credentials"] })).status).toBe(400);
    expect((await register({ redirect_uris: [GROK_CALLBACK], response_types: ["token"] })).status).toBe(400);
  });

  it("PLANT: registration is rate limited per address, and in all per day", async () => {
    const from = "192.0.2.50";
    for (let i = 0; i < PER_ADDRESS_PER_HOUR; i += 1) expect((await register({ redirect_uris: [GROK_CALLBACK] }, from)).status).toBe(201);
    const limited = await register({ redirect_uris: [GROK_CALLBACK] }, from);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3600");
    // Refused attempts count too: an allowlist miss is not a free probe.
    await testEnv.OAUTH_KV.put(dayKey(), String(ALL_PER_DAY));
    expect((await register({ redirect_uris: [GROK_CALLBACK] })).status).toBe(429);
  });

  it("a registered client gets the consent page every time, saying its name is its own claim", async () => {
    const registered = (await (await register({ client_name: "Grok", redirect_uris: [GROK_CALLBACK], token_endpoint_auth_method: "none" })).json()) as { client_id: string };
    const authorize = new URL(`${DOOR}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: GROK_CALLBACK,
      state: "s",
      code_challenge: await s256(VERIFIER),
      code_challenge_method: "S256",
      scope: "carrel:read carrel:write",
      resource: RESOURCE,
    }).toString();
    for (let i = 0; i < 2; i += 1) {
      const page = await door(new Request(authorize));
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Allow Grok to use Carrel as you?");
      expect(html).toContain("registered itself with Carrel");
      expect(html).toContain('value="read-only"');
    }
  });
});

// ---------- least scope (rule 12.3)

describe("least scope", () => {
  async function seeded() {
    await addProject("de-info", "dustinedwards");
    const site = fakeSite();
    await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: One\n---\nWords.\n", expectedVersion: null, changeId: "seed" });
    vi.stubGlobal("fetch", site.fetch);
    return connectedEnv({ ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret" });
  }

  it("PLANT: a client that asks only to read gets read: reads work, a write is refused and says how to fix it", async () => {
    const { final } = await signIn(undefined, { scope: "carrel:read" });
    const token = await tokenFor(final.searchParams.get("code")!);
    const env = await seeded();
    expect((await callTool(token, "carrel_list_projects", {}, env)).result).toMatchObject({ structuredContent: { projects: [{ slug: "de-info" }] } });
    const { result } = await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env);
    expect(result).toMatchObject({ isError: true });
    expect(result!.content[0]!.text).toContain("reading only (no carrel:write)");
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM findings").first()).toEqual({ n: 0 });
  });

  it("PLANT: the person narrows a client's write request to reading only on the consent page", async () => {
    const { final } = await signIn(undefined, { decision: "read-only" });
    const token = await tokenFor(final.searchParams.get("code")!);
    const env = await seeded();
    const { result } = await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env);
    expect(result).toMatchObject({ isError: true });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM findings").first()).toEqual({ n: 0 });
  });

  it("a client that asked to write, and was allowed, can write", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    const env = await seeded();
    expect((await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env)).result).toMatchObject({ structuredContent: { flagged: true } });
  });

  it("a client still sending the legacy scope carrel is asked for both, as its first consent was", async () => {
    const { final } = await signIn(undefined, { scope: "carrel" });
    const token = await tokenFor(final.searchParams.get("code")!);
    const env = await seeded();
    expect((await callTool(token, "carrel_add_finding", { project: "de-info", item: "post-one", message: "A flag." }, env)).result).toMatchObject({ structuredContent: { flagged: true } });
  });
});

// ---------- the token's audience (rule 12.2, RFC 8707)

describe("the token's audience", () => {
  it("PLANT: an authorization asking for another server's resource gets no code", async () => {
    const access = fakeAccess(() => ({}));
    vi.stubGlobal("fetch", access.fetch);
    const authorize = new URL(`${DOOR}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      state: "s",
      code_challenge: await s256(VERIFIER),
      code_challenge_method: "S256",
      scope: "carrel:read",
      resource: "https://mcp.dustinedwards.info/mcp",
    }).toString();
    const response = await door(new Request(authorize));
    expect(response.status).not.toBe(200);
    const location = response.headers.get("Location");
    if (location) expect(new URL(location).searchParams.get("code")).toBeNull();
  });

  it("PLANT: a token that reached the handler for any other audience is refused before the tools", async () => {
    const owner = await testEnv.DB.prepare("SELECT id FROM people WHERE email = 'owner@test.invalid'").first<{ id: number }>();
    const call = (audience: string) => {
      const ctx = Object.assign(createExecutionContext(), {
        props: { personId: owner!.id, email: "owner@test.invalid", client: "Claude", clientId: CLIENT_ID },
        auth: { audience, scope: ["carrel:read"] },
      });
      return apiHandler.fetch(modernRequest(1, "tools/call", { name: "carrel_list_projects", arguments: {} }), doorEnv(), ctx);
    };
    expect((await call("https://mcp.dustinedwards.info/mcp")).status).toBe(403);
    expect((await call(`${DOOR}/other`)).status).toBe(403);
    expect((await call(RESOURCE)).status).toBe(200);
  });

  it("never passes the client's token on: the site only ever sees Carrel's own key", async () => {
    const { final } = await signIn();
    const token = await tokenFor(final.searchParams.get("code")!);
    await addProject("de-info", "dustinedwards");
    const site = fakeSite();
    await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: One\n---\nWords.\n", expectedVersion: null, changeId: "seed" });
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push(`${request.headers.get("Authorization") ?? ""} ${request.url}`);
      return site.fetch(request);
    });
    const env = connectedEnv({ ACCESS_SAAS_CLIENT_ID: SAAS_CLIENT, ACCESS_SAAS_CLIENT_SECRET: "saas-secret" });
    const { result } = await callTool(token, "carrel_read_item", { project: "de-info", item: "post-one" }, env);
    expect(result!.isError).toBeFalsy();
    expect(sent.length).toBeGreaterThan(0);
    for (const line of sent) expect(line).not.toContain(token);
  });
});
