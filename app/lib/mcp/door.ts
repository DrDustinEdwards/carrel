// The AI door: everything on carrel-mcp.dustinedwards.info (design decision 7, corrected 2026-09-27).
//
// That hostname is exempt from Carrel's Worker-level Access (a hostname Bypass app, setup in the PR),
// because an MCP client must reach the OAuth endpoints before anyone has signed in. So nothing here
// trusts Access's own header. Instead this door is an OAuth 2.1 authorization server of its own
// (@cloudflare/workers-oauth-provider): CIMD only, no registration endpoint, and the person signs in
// upstream through Cloudflare Access for SaaS (access-login.ts). The verified email must belong to an
// active person in Carrel, checked when the grant is made and again on every request.
//
// Every request through this door is an AI session, told apart by the hostname it arrived on, never
// by email. The pages are never served here, and this door is never served on the browser's host.
//
// Routes on this host, outermost first:
//   /mcp                          the provider checks the bearer token, then apiHandler finds the
//                                 person and hands the request to server.ts
//   /authorize  /callback         the consent page and the Access sign-in, below
//   /token, /.well-known/*        served by the provider
//   /health                       liveness
//   anything else                 404

import OAuthProvider, { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { findViewer } from "~/lib/people.server";

import { accessSaas, authorizationUrl, finishSignIn, newSignIn } from "./access-login";
import { carrelOrigin, handleMcp, MCP_ROUTE } from "./server";

/** The one scope a grant carries. What a session may do comes from the person's role, not the scope. */
export const SCOPE = "carrel";

/** What a grant stores, encrypted, and hands to every request made with its tokens. */
export type DoorProps = { personId: number; email: string; client: string; clientId: string };

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

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function text(body: string, status: number, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "text/plain; charset=utf-8");
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.set(name, value);
  return new Response(body, { status, headers: out });
}

function redirect(location: string, headers?: Headers): Response {
  const out = new Headers(headers);
  out.set("Location", location);
  out.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: out });
}

/** The OAuth error answer to the client, once its redirect URI is known good. */
function redirectError(request: AuthRequest, description: string, headers?: Headers): Response {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", description);
  url.searchParams.set("state", request.state);
  if (request.issuer) url.searchParams.set("iss", request.issuer);
  return redirect(url.href, headers);
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The name a client is credited by: its CIMD client_name, or else the host that publishes it. */
function clientLabel(client: ClientInfo | null, clientId: string): string {
  const name = client?.clientName?.trim();
  if (name) return name.slice(0, 100);
  try {
    return new URL(clientId).hostname;
  } catch {
    return "an unnamed AI client";
  }
}

/**
 * The consent page. Consent has to be an act, so it is a real form. Everything from the client is
 * escaped: a CIMD document's name is chosen by whoever serves it.
 */
function consentPage(client: ClientInfo | null, request: AuthRequest, handle: string): string {
  const name = escape(clientLabel(client, request.clientId));
  const redirectHost = new URL(request.redirectUri).hostname;
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost);
  const publisher = request.clientId.startsWith("https://") ? `Published by <strong>${escape(new URL(request.clientId).hostname)}</strong>.` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Allow ${name} to use Carrel?</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px/1.6 Georgia, "Iowan Old Style", serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; line-height: 1.3; }
  .fine { font-size: .9rem; opacity: .8; }
  button { font: inherit; padding: .55rem 1.1rem; border-radius: .35rem; cursor: pointer; margin-right: .5rem; }
</style>
</head><body>
<h1>Allow ${name} to use Carrel as you?</h1>
<p>${publisher} Its access will be sent to <strong>${escape(redirectHost)}</strong>.</p>
${local ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>It can do what your role in Carrel allows, and nothing more: read, save AI drafts beside yours, and flag problems. Publishing is for Dustin's own sessions only, and never while a flag is open.</p>
<p class="fine">Next you sign in with Cloudflare Access. Only people Carrel already knows are let in.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button name="decision" value="approve">Continue to sign in</button>
  <button name="decision" value="deny">Deny</button>
</form>
</body></html>`;
}

async function authorizeGet(request: Request, env: DoorEnv): Promise<Response> {
  if (!accessSaas(env)) return text("Carrel's AI door is not configured: ACCESS_SAAS_CLIENT_ID or ACCESS_SAAS_CLIENT_SECRET is unset. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return text("Unknown OAuth client.", 400);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  // no-transform keeps Cloudflare from injecting its Web Analytics beacon into this page.
  consent.headers.set("Cache-Control", "no-store, no-transform");
  return new Response(consentPage(client, authRequest, consent.handle), { headers: consent.headers });
}

async function authorizePost(request: Request, env: DoorEnv): Promise<Response> {
  const saas = accessSaas(env);
  if (!saas) return text("Carrel's AI door is not configured. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  // Only now, after consent, does the sign-in start. The verifier and nonce stay server-side.
  const signIn = newSignIn();
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: signIn, headers: approved.headers });
  return redirect(await authorizationUrl(saas, { redirectUri: `${mcpOrigin(env)}/callback`, state, ...signIn }), headers);
}

async function callback(request: Request, env: DoorEnv): Promise<Response> {
  const saas = accessSaas(env);
  if (!saas) return text("Carrel's AI door is not configured. Not configured means not open.", 503);
  const oauth = env.OAUTH_PROVIDER;
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string; nonce: string }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) return redirectError(original, "Sign-in with Cloudflare Access did not complete.", headers);

  const signedIn = await finishSignIn(saas, { code, redirectUri: `${mcpOrigin(env)}/callback`, verifier: data.verifier, nonce: data.nonce });
  if (!signedIn.ok) {
    console.warn(JSON.stringify({ door: "sign-in-refused", reason: signedIn.reason }));
    return redirectError(original, "Carrel could not verify the sign-in.", headers);
  }
  const viewer = await findViewer(env.DB, signedIn.email);
  if (!viewer) {
    // Access let them in, but Carrel does not know them: no row, no access (design section 3).
    console.warn(JSON.stringify({ door: "refused", reason: "unknown-person" }));
    return redirectError(original, "This person is not in Carrel.", headers);
  }

  const client = clientLabel(await oauth.lookupClient(original.clientId).catch(() => null), original.clientId);
  const props: DoorProps = { personId: viewer.id, email: viewer.email, client, clientId: original.clientId };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: String(viewer.id),
    metadata: { client },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

/** Everything on this host the provider does not own. */
const loginHandler = {
  async fetch(request: Request, env: DoorEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/health") return text("ok", 200);
      if (pathname === "/authorize" && request.method === "GET") return await authorizeGet(request, env);
      if (pathname === "/authorize" && request.method === "POST") return await authorizePost(request, env);
      if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
      return text("Not found.", 404);
    } catch (error) {
      // Per the provider's consent-page guide: redirect only to a validated client, render the rest.
      if (error instanceof AuthorizationError && error.redirectUri) {
        const url = new URL(error.redirectUri);
        url.searchParams.set("error", error.code);
        url.searchParams.set("error_description", error.description);
        if (error.state) url.searchParams.set("state", error.state);
        if (error.issuer) url.searchParams.set("iss", error.issuer);
        return redirect(url.href);
      }
      if (error instanceof AuthorizationError) return text(`${error.description} Start the sign-in again from your MCP client.`, 400);
      if (error instanceof CimdFetchError) return text("This app could not be verified: its client metadata document could not be fetched.", 400);
      throw error;
    }
  },
};

/**
 * The authenticated MCP surface. The provider has checked the token by the time this runs. The
 * person is looked up again on every request: a grant lives for weeks, and a person disabled in
 * Carrel must lose the door at once, not when the grant expires.
 */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: Partial<DoorProps> }).props;
    const viewer = props?.email ? await findViewer(env.DB, props.email) : null;
    if (!viewer || viewer.id !== props?.personId) {
      console.warn(JSON.stringify({ door: "refused", reason: viewer ? "person-changed" : "unknown-person" }));
      return text("Forbidden. This grant does not belong to an active person in Carrel.", 403);
    }
    const response = await handleMcp(request, env, ctx, { viewer, client: props.client || "an unnamed AI client" }, { carrelOrigin: carrelOrigin(env) });
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(name, value);
    return out;
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

/** One provider per origin: its resource URI is fixed at construction. */
function providerFor(env: Env): OAuthProvider<Env> {
  const origin = mcpOrigin(env);
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler: loginHandler as unknown as ExportedHandler<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      scopesSupported: [SCOPE],
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
        scopes_supported: [SCOPE],
        resource_name: "Carrel",
      },
      // CIMD ONLY. claude.ai and Claude Code send their client_id as a metadata URL and never call a
      // registration endpoint (measured in dustinedwards-mcp, 2026-07-30), and MCP 2026-07-28
      // deprecates dynamic registration. There is deliberately no clientRegistrationEndpoint: no
      // client can mint itself an identity here. Needs global_fetch_strictly_public in wrangler.jsonc.
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, provider);
  }
  return provider;
}

/** Serves one request that arrived on the AI door's hostname. */
export function aiDoor(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return providerFor(env).fetch(request, env, ctx);
}
