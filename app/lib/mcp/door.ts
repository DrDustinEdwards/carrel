// The AI door: everything on carrel-mcp.dustinedwards.info (design decision 7, corrected 2026-09-27).
//
// That hostname is exempt from Desk's Access (a hostname Bypass app, setup in the PR),
// because an MCP client must reach the OAuth endpoints before anyone has signed in. So nothing here
// trusts Access's own header. Instead this door is an OAuth 2.1 authorization server of its own
// (@cloudflare/workers-oauth-provider): CIMD for Claude, Claude Code and ChatGPT, a tightened
// registration for Grok and Gemini, and the person signs in upstream through Cloudflare Access for
// SaaS. The consent page, the sign-in and the registration check are site-runtime's mcp-login, the
// same code every family MCP server runs. The verified email must belong to an active person in
// Carrel, checked when the grant is made and again on every request.
//
// Every request through this door is an AI session, told apart by the hostname it arrived on, never
// by email. The pages are never served here, and this door is never served on the browser's host.
//
// Routes on this host, outermost first:
//   /mcp                          a foreign Origin is refused first (403, before any token is read); a
//                                 named agent key (agent-keys.server.ts) goes straight to agentHandler;
//                                 anything else: the provider checks the bearer token, then apiHandler
//                                 finds the person and hands the request to server.ts. Each person (or
//                                 agent) has 30 requests a minute.
//   /authorize  /callback         the consent page and the Access sign-in (site-runtime's loginHandler)
//   /register                     tightened registration, rate limited here, then the provider
//   /token, /.well-known/*        served by the provider
//   /health                       the shared /health (health.server.ts), whose sha the deploy's live gate waits for
//   /reports/conformance.json     each site's latest conformance, public, for devkit's scoreboard
//   /reports/signed-in-security.json  Desk's signed-in pages graded in-process (signed-in-crawl.server.ts), public
//   anything else                 404

import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { recordAudit } from "@dustinedwards/site-runtime/audit-log";
import { logEvent, OWASP_EVENTS } from "@dustinedwards/site-runtime/log";
import { DCR_CALLBACKS, loginHandler, registrationLimited, registrationRefusal } from "@dustinedwards/site-runtime/mcp-login";
import { audienceRefusal, checkRateLimit, mcpOriginRefusal } from "@dustinedwards/site-runtime/mcp-server";
import { SIGNED_IN_REPORT_PATH } from "@dustinedwards/site-runtime/signed-in-crawl";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { reports } from "~/db/schema";
import { agentClient, agentPrincipal } from "~/lib/agent-keys.server";
import { healthAnswer } from "~/lib/health.server";
import { findAgentViewer, findViewer } from "~/lib/people.server";
import { SIGNED_IN_REPORT_NAME } from "~/lib/signed-in-crawl.server";

import { AGENT_SCOPES, effectiveScopes, grantScopes, SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED } from "./scopes";
import { carrelOrigin, handleMcp, MCP_ROUTE, MCP_SERVER } from "./server";

/** What a grant stores, encrypted, and hands to every request made with its tokens. */
type DoorProps = { personId: number; email: string; scopes: string[]; client: string; clientId: string };

type DoorEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/**
 * The AI door's origin. Read loosely, like CARREL_ORIGIN, because a wrangler.jsonc from before this
 * change has no CARREL_MCP_ORIGIN and its generated types would not either.
 */
export function mcpOrigin(env: Env): string {
  const configured = (env as { CARREL_MCP_ORIGIN?: string }).CARREL_MCP_ORIGIN?.trim();
  return (configured || "https://carrel-mcp.dustinedwards.info").replace(/\/+$/, "");
}

/** Whether a request arrived on the AI door's hostname. The only thing that decides the door. */
export function isMcpHost(request: Request, env: Env): boolean {
  return new URL(request.url).host.toLowerCase() === new URL(mcpOrigin(env)).host.toLowerCase();
}

// Caching and indexing only. The security headers are workers/security-headers.ts's, applied by
// workers/app.ts to every response on this host.
const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...PRIVATE_HEADERS } });
}

/**
 * The door's limit, per person (an agent is a person row too), on site-runtime's limiter: it fails
 * closed, and a refused request is a row in the call log.
 */
async function rateLimited(env: Env, personId: number, caller: string): Promise<Response | null> {
  const { allowed, retryAfter } = await checkRateLimit(env.MCP_RATE_LIMIT, `person:${personId}`);
  if (allowed) return null;
  logEvent(OWASP_EVENTS.rateLimitExceeded, { door: "ai", personId, retryAfter }, { level: "warn" });
  await recordAudit(env, { callId: crypto.randomUUID(), phase: "rate-limited", caller, server: { name: MCP_SERVER.name, version: MCP_SERVER.version } });
  const out = text(`Too many requests. Try again in ${retryAfter} seconds.`, 429);
  out.headers.set("Retry-After", String(retryAfter));
  return out;
}

/**
 * Grok and Gemini still register (as of 2026-10-09; ruling capsid/rulings/mcp-2026-10-10.md, rule 13).
 * A registration names only callbacks listed exactly: the ones every user shares (DCR_CALLBACKS) and
 * any exact https callback in DCR_REDIRECT_URIS (a per-connector id), read loosely because an older
 * wrangler.jsonc has no such var. Registration grants nothing: the consent page, Access and the
 * person check still decide. REMOVAL CONDITION: drop it when Grok and Gemini sign in by CIMD, and at
 * the latest when the MCP specification removes registration (after summer 2027).
 */
const REGISTER_PATH = "/register";
const REPORT_PATH = "/reports/conformance.json";
const registrationAllowlist = (env: Env) => [...DCR_CALLBACKS, (env as { DCR_REDIRECT_URIS?: string }).DCR_REDIRECT_URIS ?? ""].join(",");

/**
 * Everything else on this host the provider does not own: the consent page (shown for every authorization
 * of every client, nothing remembers an approval) and the Access /callback.
 */
const login = loginHandler<DoorEnv>({
  name: "Carrel",
  scopes: { read: SCOPE_READ, write: SCOPE_WRITE },
  about:
    "<p>It can read as you. With changes allowed it can also save AI drafts beside yours and flag problems. Either way it can do only what your role in Carrel allows. Publishing, the site's text or the session's own AI draft, is for Dustin's own sessions only, and never while a flag is open.</p>",
  admits: { consent: "Only people Carrel already knows are let in.", refusal: "This person is not in Carrel." },
  // Access let them in, but Carrel must know them too: no row, no access (design section 3). The
  // person's id travels with the grant and is checked again on every request.
  admit: async (env, { email }) => {
    const viewer = await findViewer(env.DB, email);
    return viewer ? { personId: viewer.id } : null;
  },
  // A client that names no Carrel scope, or the legacy one, is offered writing too (scopes.ts).
  wantsWrite: (requested) => grantScopes(requested).includes(SCOPE_WRITE),
  // Every sign-in, admitted or refused, is a `sign-in` row in the call log beside the tool calls.
  audit: { name: MCP_SERVER.name, version: MCP_SERVER.version },
});

/**
 * The authenticated MCP surface. The provider has checked the token by the time this runs. The
 * person is looked up again on every request: a grant lives for weeks, and a person disabled in
 * Carrel must lose the door at once, not when the grant expires.
 */
export const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as ExecutionContext & { props?: Partial<DoorProps>; auth?: { audience?: string; scope?: string[] } };
    // The token must have been issued for this server (RFC 8707), checked here as well as by the
    // provider, so a provider set up for a second resource could never hand Carrel a token for it.
    // Nothing passes the token on: the site and the novels repository take Carrel's own keys.
    const foreign = audienceRefusal(auth, `${mcpOrigin(env)}${MCP_ROUTE}`, [SCOPE_READ]);
    if (foreign) {
      logEvent(OWASP_EVENTS.authorizationFailure, { door: "ai", reason: "audience", audience: auth?.audience ?? null }, { level: "warn" });
      return foreign;
    }
    const viewer = props?.email ? await findViewer(env.DB, props.email) : null;
    if (!viewer || viewer.id !== props?.personId) {
      logEvent(OWASP_EVENTS.authorizationFailure, { door: "ai", reason: viewer ? "person-changed" : "unknown-person" }, { level: "warn" });
      return text("Forbidden. This grant does not belong to an active person in Carrel.", 403);
    }
    const throttled = await rateLimited(env, viewer.id, `access:${viewer.email}`);
    if (throttled) return throttled;
    const session = { viewer, client: props.client || "an unnamed AI client", clientId: props.clientId, scopes: effectiveScopes(auth?.scope ?? []) };
    const response = await handleMcp(request, env, ctx, session, { carrelOrigin: carrelOrigin(env) });
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(name, value);
    return out;
  },
};

/**
 * The named-agent surface. A key (agent-keys.server.ts) names an agent, and the agent is the person
 * row "agent:<name>" in Carrel's People table, found again on every request: disabling that row
 * revokes the agent at once, and its role on each project is whatever People says, never the key's.
 * A key with no active row is refused here and never falls through to anything. Writes are credited
 * to "agent:<name>", the same text as the person, never to Dustin.
 */
async function agentHandler(request: Request, env: Env, ctx: ExecutionContext, name: string): Promise<Response> {
  const viewer = await findAgentViewer(env.DB, name);
  if (!viewer) {
    logEvent(OWASP_EVENTS.authorizationFailure, { door: "ai", reason: "agent-not-in-carrel", agent: name }, { level: "warn" });
    return text("Forbidden. This agent key does not belong to an active agent in Carrel.", 403);
  }
  logEvent(OWASP_EVENTS.signInSuccess, { door: "ai", method: "agent-key", agent: name });
  const throttled = await rateLimited(env, viewer.id, `agent:${name}`);
  if (throttled) return throttled;
  const response = await handleMcp(request, env, ctx, { viewer, client: agentClient(name), scopes: AGENT_SCOPES }, { carrelOrigin: carrelOrigin(env) });
  const out = new Response(response.body, response);
  for (const [header, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(header, value);
  return out;
}

const providers = new Map<string, OAuthProvider<Env>>();

/**
 * One provider per origin and registration allowlist: the resource URI and the registration policy
 * are both fixed at construction, so a changed allowlist gets a new provider, never a stale one.
 */
function providerFor(env: Env): OAuthProvider<Env> {
  const origin = mcpOrigin(env);
  const allowed = registrationAllowlist(env);
  const key = `${origin} ${allowed}`;
  let provider = providers.get(key);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler: login as unknown as ExportedHandler<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      scopesSupported: SCOPES_SUPPORTED,
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
        scopes_supported: SCOPES_SUPPORTED,
        resource_name: "Carrel",
      },
      // CIMD first. claude.ai, Claude Code and ChatGPT send their client_id as a metadata URL and
      // never register (measured in dustinedwards-mcp, 2026-07-30). Needs global_fetch_strictly_public
      // in wrangler.jsonc.
      clientIdMetadataDocumentEnabled: true,
      // Tightened registration beside it, for Grok and Gemini (rule 13): exact callbacks only, rate
      // limited in aiDoor before it gets here. The provider itself refuses any grant but code and refresh.
      clientRegistrationEndpoint: REGISTER_PATH,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const why = registrationRefusal(allowed, clientMetadata);
        return why ? { code: "invalid_redirect_uri", description: why } : undefined;
      },
    });
    providers.set(key, provider);
  }
  return provider;
}

/** A stored public report, as stored: the health run's conformance report (health.server.ts) or the signed-in crawl's
 *  (signed-in-crawl.server.ts). Before the first run there is none. */
async function storedReport(env: Env, name: string): Promise<Response> {
  const row = await drizzle(env.DB).select({ body: reports.body }).from(reports).where(eq(reports.name, name)).get();
  if (!row) return text("No report yet.", 404);
  return new Response(row.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ...PRIVATE_HEADERS } });
}

/** Serves one request that arrived on the AI door's hostname. */
export async function aiDoor(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return healthAnswer(env);
  if (pathname === REPORT_PATH && request.method === "GET") return storedReport(env, "conformance");
  if (pathname === SIGNED_IN_REPORT_PATH && request.method === "GET") return storedReport(env, SIGNED_IN_REPORT_NAME);
  if (pathname === MCP_ROUTE || pathname.startsWith(`${MCP_ROUTE}/`)) {
    // Before any token is read, so a page on another origin gets 403, never a 401 to retry with a token.
    const foreign = mcpOriginRefusal(request, [], PRIVATE_HEADERS);
    if (foreign) return foreign;
    // Tried, never required: no match (no secret, a bad header, an OAuth token) is the OAuth path, unchanged.
    const agent = await agentPrincipal(env, request.headers.get("Authorization"));
    if (agent) return agentHandler(request, env, ctx, agent);
  }
  if (pathname === REGISTER_PATH && request.method === "POST") {
    const limited = await registrationLimited(request, env.OAUTH_KV);
    if (limited) return limited;
  }
  return providerFor(env).fetch(request, env, ctx);
}
