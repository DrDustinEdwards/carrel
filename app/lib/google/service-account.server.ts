// The Google service account (design decision 6): it reads the manuscripts folder's metadata and
// Search Console, and, for the Docs tools (the Docs plan, slices 1 and 2), reads Docs and lays suggestions
// and comments in them. It cannot do anything else. Two walls: Google lets it reach only what is shared with
// it, and every request it makes passes an allowlist here, so anything outside the list, and any change to a
// Doc that is not a suggestion or a comment, is refused in code before anything is sent, whatever the scopes
// would allow.

import {
  clearServiceAccountTokens,
  GOOGLE_TOKEN_URL,
  parseServiceAccountKey,
  serviceAccountToken,
  type ServiceAccountKey as SharedKey,
} from "@dustinedwards/site-runtime/google-service-account";
import { timedFetch } from "@dustinedwards/site-runtime/http";

/**
 * No drive.readonly: the index takes metadata, and search asks Drive each time. `documents` is the Docs API's one
 * scope that can write, which suggestions and comments need; docBatchProblem below keeps it to those.
 */
export const SA_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/documents",
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
  constructor(method: string, url: string, why = "it is outside what the service account may do") {
    super(`${method} ${url} was refused before it was sent: ${why}.`);
    this.name = "ServiceAccountRefused";
  }
}

// Every request the service account may make: listing files (metadata), Search Console's query (a POST that
// reads), and the Docs API's read and batchUpdate on one Doc. Not Drive's files.get, whose alt=media
// returns a file's content. A batchUpdate also passes docBatchProblem.
const ALLOWED: { method: string; url: RegExp }[] = [
  { method: "GET", url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/files(\?|$)/ },
  {
    method: "POST",
    url: /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/,
  },
  {
    method: "GET",
    url: /^https:\/\/docs\.googleapis\.com\/v1\/documents\/[A-Za-z0-9_-]{10,100}(\?|$)/,
  },
  {
    method: "POST",
    url: /^https:\/\/docs\.googleapis\.com\/v1\/documents\/[A-Za-z0-9_-]{10,100}:batchUpdate$/,
  },
];

// The only changes the service account may make in a Doc. Text requests are allowed only as suggestions
// (writeMode SUGGEST), so a call that would change a Doc's text directly never leaves Carrel; comments and replies
// are allowed alone, and never with an assignee, which sends an email to another person.
const DOC_TEXT_REQUESTS = ["insertText", "deleteContentRange"];
const DOC_COMMENT_REQUESTS = ["insertComment", "addCommentReply"];

function docBatchProblem(body: unknown): string | null {
  const batch = body as {
    requests?: Record<string, unknown>[];
    writeControl?: { writeMode?: string };
  };
  if (!batch || !Array.isArray(batch.requests) || batch.requests.length === 0)
    return "a Doc batch needs requests";
  const kinds = batch.requests.map((r) => Object.keys(r ?? {}));
  if (kinds.some((k) => k.length !== 1)) return "each Doc request names exactly one change";
  const names = kinds.map((k) => k[0]!);
  const text = names.filter((n) => DOC_TEXT_REQUESTS.includes(n)).length;
  const comment = names.filter((n) => DOC_COMMENT_REQUESTS.includes(n)).length;
  if (text + comment !== names.length || (text > 0 && comment > 0))
    return `only ${[...DOC_TEXT_REQUESTS, ...DOC_COMMENT_REQUESTS].join(", ")} are allowed, and text and comments are not mixed`;
  if (text > 0 && batch.writeControl?.writeMode !== "SUGGEST")
    return "a change to a Doc's text goes only as a suggestion (writeMode SUGGEST)";
  if (comment > 0 && batch.writeControl?.writeMode === "SUGGEST")
    return "comments do not go in suggest mode";
  const assigns = JSON.stringify(batch.requests).match(/"assignee(Email(Address)?)?"/);
  return assigns ? "a comment never names an assignee: that emails someone" : null;
}

/** Throws ServiceAccountRefused unless the request is on the allowlist (and, for a Doc batch, passes the wall). */
export function assertAllowed(method: string, url: string, body?: unknown): void {
  const m = method.toUpperCase();
  // alt=media asks for content instead of metadata, wherever it appears.
  const media =
    new URL(url).searchParams.has("alt") && new URL(url).searchParams.get("alt") !== "json";
  if (media || !ALLOWED.some((a) => a.method === m && a.url.test(url)))
    throw new ServiceAccountRefused(m, url);
  if (url.endsWith(":batchUpdate")) {
    const problem = docBatchProblem(body);
    if (problem) throw new ServiceAccountRefused(m, url, problem);
  }
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

/** The service account's only way to reach Google: by allowlist, then authenticated. */
export function saClient(env: Env, fetcher: Fetch = timedFetch) {
  const connection = saConnection(env);
  if (connection.state !== "connected") throw new GoogleNotConnected(connection.detail);
  return {
    key: connection.key,
    async request(method: string, url: string, body?: unknown): Promise<Response> {
      assertAllowed(method, url, body);
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
