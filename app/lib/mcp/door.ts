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
//   /mcp                          a named agent key (agent-keys.server.ts) goes straight to agentHandler;
//                                 anything else: the provider checks the bearer token, then apiHandler
//                                 finds the person and hands the request to server.ts
//   /authorize  /callback         the consent page and the Access sign-in (site-runtime's loginHandler)
//   /register                     tightened registration, rate limited here, then the provider
//   /token, /.well-known/*        served by the provider
//   /health                       liveness, and the deployed commit for the deploy's live gate
//   anything else                 404

import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { DCR_CALLBACKS, loginHandler, registrationLimited, registrationRefusal } from "@dustinedwards/site-runtime/mcp-login";

import { agentClient, agentPrincipal } from "~/lib/agent-keys.server";
import { deployedSha } from "~/lib/deployed";
import { findAgentViewer, findViewer } from "~/lib/people.server";

import { AGENT_SCOPES, effectiveScopes, grantScopes, SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED } from "./scopes";
import { carrelOrigin, handleMcp, MCP_ROUTE } from "./server";

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
 * Liveness on the AI door, the one Carrel host outside Access, so CI can read it before anyone signs in.
 * The live gate polls it until `sha` is the commit it deployed. It says nothing else: no backup age, no
 * table, no error text (the backup health stays on the browser host's /health, behind Access).
 */
function liveness(env: Env): Response {
  const out = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.set(name, value);
  return new Response(JSON.stringify({ ok: true, sha: deployedSha(env) }), { status: 200, headers: out });
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
const registrationAllowlist = (env: Env) => [...DCR_CALLBACKS, (env as { DCR_REDIRECT_URIS?: string }).DCR_REDIRECT_URIS ?? ""].join(",");

/**
 * Everything on this host the provider does not own: /health, the consent page (shown for every
 * authorization of every client, nothing remembers an approval) and the Access /callback.
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
  health: liveness,
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
    if (auth?.audience !== `${mcpOrigin(env)}${MCP_ROUTE}`) {
      console.warn(JSON.stringify({ door: "refused", reason: "audience", audience: auth?.audience ?? null }));
      return text("Forbidden. This token was not issued for Carrel.", 403);
    }
    const viewer = props?.email ? await findViewer(env.DB, props.email) : null;
    if (!viewer || viewer.id !== props?.personId) {
      console.warn(JSON.stringify({ door: "refused", reason: viewer ? "person-changed" : "unknown-person" }));
      return text("Forbidden. This grant does not belong to an active person in Carrel.", 403);
    }
    const session = { viewer, client: props.client || "an unnamed AI client", scopes: effectiveScopes(auth.scope ?? []) };
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
    console.warn(JSON.stringify({ door: "refused", reason: "agent-not-in-carrel", agent: name }));
    return text("Forbidden. This agent key does not belong to an active agent in Carrel.", 403);
  }
  console.log(JSON.stringify({ door: "agent-key-accepted", agent: name }));
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

/** Serves one request that arrived on the AI door's hostname. */
export async function aiDoor(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === MCP_ROUTE || pathname.startsWith(`${MCP_ROUTE}/`)) {
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
