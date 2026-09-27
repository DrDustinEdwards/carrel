// The upstream login for the AI door: Cloudflare Access for SaaS, as an OIDC provider (Cloudflare's
// "Secure MCP servers" doc, developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/
// secure-mcp-servers). Carrel is the OAuth authorization server for MCP clients (door.ts); it does not
// know who the person is, so it sends them to Access, which signs them in with the team's login and
// returns an ID token whose email Carrel maps to its people table.
//
// Every endpoint is derived from the team domain and the SaaS app's client id, as the Access
// dashboard shows them, so the only settings are the two secrets. Fails closed: a missing setting
// keeps the door shut.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { teamIssuer } from "~/lib/access.server";

export type AccessSaas = {
  clientId: string;
  clientSecret: string;
  /** The SaaS app's issuer: https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id> */
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
};

/** The Access for SaaS app's endpoints, or null while any setting is missing. */
export function accessSaas(env: Env): AccessSaas | null {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const clientId = env.ACCESS_SAAS_CLIENT_ID?.trim();
  const clientSecret = env.ACCESS_SAAS_CLIENT_SECRET?.trim();
  if (!team || !clientId || !clientSecret) return null;
  const issuer = `${teamIssuer(team)}/cdn-cgi/access/sso/oidc/${encodeURIComponent(clientId)}`;
  return { clientId, clientSecret, issuer, authorizationUrl: `${issuer}/authorization`, tokenUrl: `${issuer}/token`, jwksUrl: `${issuer}/jwks` };
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

function keysFor(saas: AccessSaas): JWTVerifyGetKey {
  let keys = remoteKeys.get(saas.jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(saas.jwksUrl));
    remoteKeys.set(saas.jwksUrl, keys);
  }
  return keys;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh PKCE verifier and OIDC nonce for one sign-in. Kept server-side by beginUpstream. */
export function newSignIn(): { verifier: string; nonce: string } {
  return { verifier: `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""), nonce: crypto.randomUUID() };
}

/** Where the browser goes to sign in with Access. */
export async function authorizationUrl(saas: AccessSaas, input: { redirectUri: string; state: string; verifier: string; nonce: string }): Promise<string> {
  const url = new URL(saas.authorizationUrl);
  url.searchParams.set("client_id", saas.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", await s256(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export type SignedIn = { ok: true; email: string } | { ok: false; reason: string };

/**
 * Exchanges Access's code for tokens and verifies the ID token: signed by the SaaS app's keys, issued
 * by it, for this client, carrying the nonce this sign-in sent, and naming an email. Anything else is
 * a refusal.
 */
export async function finishSignIn(
  saas: AccessSaas,
  input: { code: string; redirectUri: string; verifier: string; nonce: string },
  keys: JWTVerifyGetKey = keysFor(saas),
): Promise<SignedIn> {
  const response = await fetch(saas.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: saas.clientId,
      client_secret: saas.clientSecret,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) return { ok: false, reason: `token-exchange-${response.status}` };
  const tokens = (await response.json().catch(() => ({}))) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") return { ok: false, reason: "no-id-token" };

  let payload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, keys, { issuer: saas.issuer, audience: saas.clientId, algorithms: ["RS256"] }));
  } catch {
    return { ok: false, reason: "invalid-id-token" };
  }
  if (payload.nonce !== input.nonce) return { ok: false, reason: "nonce-mismatch" };
  if (payload.email_verified === false) return { ok: false, reason: "email-not-verified" };
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return { ok: false, reason: "no-email" };
  return { ok: true, email };
}
