// The Google service account (design decision 6): it reads the manuscripts folder's metadata and
// Search Console, and, for the Docs tools (the Docs plan, slices 1 to 3), reads Docs, lays suggestions and comments in
// them, and on the Owner's own ask writes directly or accepts. It cannot do anything else. Two walls: Google lets it
// reach only what is shared with it, and every request it makes passes an allowlist here, so anything outside the
// list, and any direct change to a Doc's text the caller did not mark as the Owner's ask, is refused in code before
// anything is sent, whatever the scopes would allow.

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

// The only changes the service account may make in a Doc, in four kinds that never share a batch:
// - text: allowed as suggestions (writeMode SUGGEST); without it only when the caller marks the batch `direct`,
//   which docs.server.ts does for the Owner's own ask on a Doc that is not locked;
// - comments and replies, never with an assignee, which sends an email to another person;
// - decisions on suggestions: rejecting or withdrawing one, and accepting one only when `direct`;
// - deleting a comment thread (undo of Carrel's own comment; Google allows it only to the thread's author).
const DOC_TEXT_REQUESTS = ["insertText", "deleteContentRange"];
const DOC_COMMENT_REQUESTS = ["insertComment", "addCommentReply"];
const DOC_REVIEW_REQUESTS = ["acceptSuggestion", "rejectSuggestion", "deleteSuggestion"];
const DOC_DELETE_REQUESTS = ["deleteComment"];
const DOC_KINDS = [
  DOC_TEXT_REQUESTS,
  DOC_COMMENT_REQUESTS,
  DOC_REVIEW_REQUESTS,
  DOC_DELETE_REQUESTS,
];

/** `direct` is the Owner's own ask, checked by the caller: a text change or an accept that is not a suggestion. */
export type DocWrite = { direct?: boolean };

function docBatchProblem(body: unknown, opts: DocWrite = {}): string | null {
  const batch = body as {
    requests?: Record<string, unknown>[];
    writeControl?: { writeMode?: string };
  };
  if (!batch || !Array.isArray(batch.requests) || batch.requests.length === 0)
    return "a Doc batch needs requests";
  const kinds = batch.requests.map((r) => Object.keys(r ?? {}));
  if (kinds.some((k) => k.length !== 1)) return "each Doc request names exactly one change";
  const names = kinds.map((k) => k[0]!);
  const used = DOC_KINDS.filter((kind) => names.some((n) => kind.includes(n)));
  if (names.some((n) => !DOC_KINDS.flat().includes(n)) || used.length !== 1)
    return `only ${DOC_KINDS.flat().join(", ")} are allowed, and the kinds are not mixed`;
  const suggest = batch.writeControl?.writeMode === "SUGGEST";
  if (used[0] === DOC_TEXT_REQUESTS) {
    if (!suggest && !opts.direct)
      return "a change to a Doc's text goes only as a suggestion (writeMode SUGGEST), unless it is the Owner's own ask";
    if (suggest && opts.direct) return "a direct write does not go in suggest mode";
    return null;
  }
  if (suggest) return "only text changes go in suggest mode";
  if (names.includes("acceptSuggestion") && !opts.direct)
    return "accepting a suggestion is the Owner's own ask";
  const assigns = JSON.stringify(batch.requests).match(/"assignee(Email(Address)?)?"/);
  return assigns ? "a comment never names an assignee: that emails someone" : null;
}

/** Throws ServiceAccountRefused unless the request is on the allowlist (and, for a Doc batch, passes the wall). */
export function assertAllowed(
  method: string,
  url: string,
  body?: unknown,
  opts: DocWrite = {},
): void {
  const m = method.toUpperCase();
  // alt=media asks for content instead of metadata, wherever it appears.
  const media =
    new URL(url).searchParams.has("alt") && new URL(url).searchParams.get("alt") !== "json";
  if (media || !ALLOWED.some((a) => a.method === m && a.url.test(url)))
    throw new ServiceAccountRefused(m, url);
  if (url.endsWith(":batchUpdate")) {
    const problem = docBatchProblem(body, opts);
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
    async request(
      method: string,
      url: string,
      body?: unknown,
      opts: DocWrite = {},
    ): Promise<Response> {
      assertAllowed(method, url, body, opts);
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
