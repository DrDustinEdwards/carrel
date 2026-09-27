// The Google service account (design decision 6): it reads the manuscripts folder's metadata and
// Search Console, and cannot do anything else. Two walls: it asks Google only for read-only scopes,
// and every request it makes passes an allowlist here, so a write through it is refused in code
// before anything is sent, whatever the scopes would allow.

import { SignJWT } from "jose";

/** Read-only, and no drive.readonly: the index takes metadata, and search asks Drive each time. */
export const SA_SCOPES = ["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/webmasters.readonly"];

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ServiceAccountKey = { clientEmail: string; privateKey: string; privateKeyId: string; tokenUri: string };

export type SaConnection =
  | { state: "connected"; key: ServiceAccountKey }
  | { state: "not-connected"; detail: string }
  | { state: "misconfigured"; detail: string };

export function saConnection(env: Env): SaConnection {
  const raw = env.GOOGLE_SA_KEY?.trim();
  if (!raw) return { state: "not-connected", detail: "GOOGLE_SA_KEY is not set, so the manuscripts index and Search Console are off." };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { state: "misconfigured", detail: "GOOGLE_SA_KEY is not JSON; set it to the whole key file Google downloads." };
  }
  const { type, client_email, private_key, private_key_id, token_uri } = parsed;
  if (type !== "service_account" || typeof client_email !== "string" || typeof private_key !== "string" || typeof private_key_id !== "string") {
    return { state: "misconfigured", detail: "GOOGLE_SA_KEY is not a service account key file (type, client_email, private_key, private_key_id)." };
  }
  if (!private_key.includes("BEGIN PRIVATE KEY")) return { state: "misconfigured", detail: "GOOGLE_SA_KEY's private_key is not a PKCS#8 PEM key." };
  // A key file pointing its token endpoint anywhere but Google's would hand the signed assertion elsewhere.
  const tokenUri = typeof token_uri === "string" ? token_uri : GOOGLE_TOKEN_URL;
  if (tokenUri !== GOOGLE_TOKEN_URL) return { state: "misconfigured", detail: `GOOGLE_SA_KEY's token_uri is ${tokenUri}, not Google's.` };
  return { state: "connected", key: { clientEmail: client_email, privateKey: private_key, privateKeyId: private_key_id, tokenUri } };
}

export class GoogleNotConnected extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "GoogleNotConnected";
  }
}

/** A request the service account is not allowed to make: refused here, never sent. */
export class ServiceAccountRefused extends Error {
  constructor(method: string, url: string) {
    super(`The service account may only read; ${method} ${url} was refused before it was sent.`);
    this.name = "ServiceAccountRefused";
  }
}

// Every request the service account may make: listing files (metadata) and Search Console's query,
// a POST that reads. Not files.get, whose alt=media returns a file's content.
const ALLOWED: { method: string; url: RegExp }[] = [
  { method: "GET", url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/files(\?|$)/ },
  { method: "POST", url: /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/ },
];

export function assertReadOnly(method: string, url: string): void {
  const m = method.toUpperCase();
  // alt=media asks for content instead of metadata, wherever it appears.
  const media = new URL(url).searchParams.has("alt") && new URL(url).searchParams.get("alt") !== "json";
  if (media || !ALLOWED.some((a) => a.method === m && a.url.test(url))) throw new ServiceAccountRefused(m, url);
}

type Fetch = typeof fetch;

const tokenCache = new Map<string, { token: string; expires: number }>();

export function clearSaTokenCache(): void {
  tokenCache.clear();
}

/** A signed JWT exchanged at Google's token endpoint for an hour's access token, cached per key. */
export async function saAccessToken(key: ServiceAccountKey, fetcher: Fetch = fetch, now = Date.now()): Promise<string> {
  const cached = tokenCache.get(key.privateKeyId);
  if (cached && cached.expires - 5 * 60_000 > now) return cached.token;
  const pem = key.privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signingKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const assertion = await new SignJWT({ scope: SA_SCOPES.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid: key.privateKeyId, typ: "JWT" })
    .setIssuer(key.clientEmail)
    .setAudience(key.tokenUri)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(signingKey);
  const res = await fetcher(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    // invalid_grant is how Google answers a deleted, disabled or expired key.
    throw new Error(`Google refused the service account key (${res.status} ${body.error ?? ""}${body.error_description ? `: ${body.error_description}` : ""}).`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key.privateKeyId, { token: body.access_token, expires: now + body.expires_in * 1000 });
  return body.access_token;
}

/** The service account's only way to reach Google: read-only by allowlist, then authenticated. */
export function saClient(env: Env, fetcher: Fetch = fetch) {
  const connection = saConnection(env);
  if (connection.state !== "connected") throw new GoogleNotConnected(connection.detail);
  return {
    key: connection.key,
    async request(method: string, url: string, body?: unknown): Promise<Response> {
      assertReadOnly(method, url);
      const token = await saAccessToken(connection.key, fetcher);
      return fetcher(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}
