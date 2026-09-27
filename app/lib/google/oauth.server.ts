// Dustin's own Google grant (design decision 6): drive.file only, which reaches only files Carrel
// itself created or he opened with it, used for Send to Docs and Import. The refresh token is kept in
// D1 encrypted under a key from `wrangler secret`, so the database alone cannot use it.

import { and, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { googleOauthStates, googleTokens } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";

import { GOOGLE_TOKEN_URL, GoogleNotConnected } from "./service-account.server";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const STATE_TTL_MS = 10 * 60_000;

type Fetch = typeof fetch;

export type OauthConnection =
  | { state: "configured"; clientId: string; clientSecret: string; key: CryptoKey | null }
  | { state: "not-configured"; detail: string }
  | { state: "misconfigured"; detail: string };

async function tokenKey(raw: string | undefined): Promise<CryptoKey | null> {
  if (!raw?.trim()) return null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function oauthConnection(env: Env): Promise<OauthConnection> {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret && !env.GOOGLE_TOKEN_KEY) {
    return { state: "not-configured", detail: "Google sign-in for Send to Docs is not set up yet (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_KEY)." };
  }
  if (!clientId || !clientSecret) return { state: "misconfigured", detail: "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set." };
  const key = await tokenKey(env.GOOGLE_TOKEN_KEY);
  if (!key) return { state: "misconfigured", detail: "GOOGLE_TOKEN_KEY must be 32 random bytes in base64, so the refresh token can be stored encrypted." };
  return { state: "configured", clientId, clientSecret, key };
}

async function configured(env: Env) {
  const c = await oauthConnection(env);
  if (c.state !== "configured" || !c.key) throw new GoogleNotConnected(c.state === "configured" ? "GOOGLE_TOKEN_KEY is missing." : c.detail);
  return { clientId: c.clientId, clientSecret: c.clientSecret, key: c.key };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function encryptToken(key: CryptoKey, token: string): Promise<{ data: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)));
  return { data: b64(data), iv: b64(iv) };
}

export async function decryptToken(key: CryptoKey, data: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(data));
  return new TextDecoder().decode(plain);
}

/** Dustin's grant is his alone: Send to Docs sends outside Carrel, the Owner's action. */
function requireOwner(viewer: Viewer) {
  if (!viewer.isOwner) throw new Response("Forbidden", { status: 403 });
}

/** Where Google sends the browser back: the browser door's own origin. */
export function redirectUri(origin: string): string {
  return `${origin}/auth/google/callback`;
}

export async function startAuth(env: Env, viewer: Viewer, origin: string, now = new Date()): Promise<string> {
  requireOwner(viewer);
  const { clientId } = await configured(env);
  const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "");
  const d = drizzle(env.DB);
  await d.delete(googleOauthStates).where(lt(googleOauthStates.createdAt, new Date(now.getTime() - STATE_TTL_MS).toISOString()));
  await d.insert(googleOauthStates).values({ state, personId: viewer.id, createdAt: now.toISOString() });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: DRIVE_FILE_SCOPE,
    access_type: "offline",
    // Consent each time, so Google returns a refresh token even for a second connection.
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  }).toString();
  return url.toString();
}

/**
 * Finishes the round trip: the state must be one Carrel issued to this person in the last ten
 * minutes, used once; the grant must be drive.file and nothing wider.
 */
export async function finishAuth(env: Env, viewer: Viewer, params: URLSearchParams, origin: string, fetcher: Fetch = fetch, now = new Date()) {
  requireOwner(viewer);
  const { clientId, clientSecret, key } = await configured(env);
  const d = drizzle(env.DB);
  const state = params.get("state") ?? "";
  const used = await d
    .delete(googleOauthStates)
    .where(and(eq(googleOauthStates.state, state), eq(googleOauthStates.personId, viewer.id)))
    .returning({ createdAt: googleOauthStates.createdAt });
  if (!used[0] || Date.parse(used[0].createdAt) < now.getTime() - STATE_TTL_MS) {
    return { ok: false as const, message: "That sign-in link was not started here, or has expired. Start again from Carrel." };
  }
  const error = params.get("error");
  if (error) return { ok: false as const, message: `Google did not grant access (${error}).` };
  const code = params.get("code");
  if (!code) return { ok: false as const, message: "Google sent no code back." };

  const res = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(origin), grant_type: "authorization_code" }).toString(),
  });
  if (!res.ok) return { ok: false as const, message: `Google refused the code (${res.status}).` };
  const body = (await res.json()) as { refresh_token?: string; scope?: string };
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  // Anything beyond drive.file (bar the identity scopes Google may add) is not what Carrel asked for.
  const extra = scopes.filter((s) => s !== DRIVE_FILE_SCOPE && !["openid", "email", "profile"].includes(s) && !s.endsWith("/userinfo.email") && !s.endsWith("/userinfo.profile"));
  if (!scopes.includes(DRIVE_FILE_SCOPE) || extra.length > 0) {
    return { ok: false as const, message: `Google granted ${scopes.join(", ") || "nothing"}; Carrel keeps only a drive.file grant. Nothing was stored.` };
  }
  if (!body.refresh_token) return { ok: false as const, message: "Google returned no refresh token. Remove Carrel's access in your Google account and connect again." };
  const sealed = await encryptToken(key, body.refresh_token);
  await d
    .insert(googleTokens)
    .values({ personId: viewer.id, refreshToken: sealed.data, iv: sealed.iv, scope: DRIVE_FILE_SCOPE, connectedAt: now.toISOString() })
    .onConflictDoUpdate({ target: googleTokens.personId, set: { refreshToken: sealed.data, iv: sealed.iv, scope: DRIVE_FILE_SCOPE, connectedAt: now.toISOString(), lastError: null } });
  return { ok: true as const };
}

export async function isConnected(db: D1Database, viewer: Viewer): Promise<boolean> {
  return Boolean(await drizzle(db).select({ id: googleTokens.personId }).from(googleTokens).where(eq(googleTokens.personId, viewer.id)).get());
}

/** An access token from the stored grant. A revoked grant is recorded, so the health check can say so. */
export async function userAccessToken(env: Env, personId: number, fetcher: Fetch = fetch): Promise<string> {
  const { clientId, clientSecret, key } = await configured(env);
  const d = drizzle(env.DB);
  const row = await d.select().from(googleTokens).where(eq(googleTokens.personId, personId)).get();
  if (!row) throw new GoogleNotConnected("Google is not connected for Send to Docs yet. Connect it from the home page.");
  const refresh = await decryptToken(key, row.refreshToken, row.iv);
  const res = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const message = `Google refused the drive.file grant (${res.status} ${body.error ?? ""}). Connect Google again from the home page.`;
    await d.update(googleTokens).set({ lastError: message }).where(eq(googleTokens.personId, personId));
    throw new GoogleNotConnected(message);
  }
  if (row.lastError) await d.update(googleTokens).set({ lastError: null }).where(eq(googleTokens.personId, personId));
  return ((await res.json()) as { access_token: string }).access_token;
}
