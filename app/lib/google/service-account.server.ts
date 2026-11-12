// The Google service account (design decision 6): it reads the manuscripts folder's metadata and
// Search Console, and cannot do anything else. Two walls: it asks Google only for read-only scopes,
// and every request it makes passes an allowlist here, so a write through it is refused in code
// before anything is sent, whatever the scopes would allow.

import {
  clearServiceAccountTokens,
  GOOGLE_TOKEN_URL,
  parseServiceAccountKey,
  serviceAccountToken,
  type ServiceAccountKey as SharedKey,
} from "@dustinedwards/site-runtime/google-service-account";
import { timedFetch } from "@dustinedwards/site-runtime/http";

/** Read-only, and no drive.readonly: the index takes metadata, and search asks Drive each time. */
export const SA_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

export { GOOGLE_TOKEN_URL };

/** The key file's fields; carrel also needs `privateKeyId`, which the health check tracks. */
export type ServiceAccountKey = SharedKey & { privateKeyId: string };

export type SaConnection =
  | { state: "connected"; key: ServiceAccountKey }
  | { state: "not-connected"; detail: string }
  | { state: "misconfigured"; detail: string };

export function saConnection(env: Env): SaConnection {
  const parsed = parseServiceAccountKey(env.GOOGLE_SA_KEY, "GOOGLE_SA_KEY");
  if (!parsed.ok)
    return parsed.state === "not-connected"
      ? {
          state: "not-connected",
          detail: "GOOGLE_SA_KEY is not set, so the manuscripts index and Search Console are off.",
        }
      : { state: "misconfigured", detail: parsed.detail };
  const { privateKeyId } = parsed.key;
  if (!privateKeyId)
    return { state: "misconfigured", detail: "GOOGLE_SA_KEY has no private_key_id." };
  return { state: "connected", key: { ...parsed.key, privateKeyId } };
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
  {
    method: "POST",
    url: /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/,
  },
];

export function assertReadOnly(method: string, url: string): void {
  const m = method.toUpperCase();
  // alt=media asks for content instead of metadata, wherever it appears.
  const media =
    new URL(url).searchParams.has("alt") && new URL(url).searchParams.get("alt") !== "json";
  if (media || !ALLOWED.some((a) => a.method === m && a.url.test(url)))
    throw new ServiceAccountRefused(m, url);
}

type Fetch = typeof fetch;

export function clearSaTokenCache(): void {
  clearServiceAccountTokens();
}

/** An hour's access token for SA_SCOPES (site-runtime ./google-service-account), cached per key. */
export function saAccessToken(
  key: ServiceAccountKey,
  fetcher: Fetch = timedFetch,
  now = Date.now(),
): Promise<string> {
  return serviceAccountToken(key, SA_SCOPES, { fetcher, now });
}

/** The service account's only way to reach Google: read-only by allowlist, then authenticated. */
export function saClient(env: Env, fetcher: Fetch = timedFetch) {
  const connection = saConnection(env);
  if (connection.state !== "connected") throw new GoogleNotConnected(connection.detail);
  return {
    key: connection.key,
    async request(method: string, url: string, body?: unknown): Promise<Response> {
      assertReadOnly(method, url);
      const token = await saAccessToken(connection.key, fetcher);
      return fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}
