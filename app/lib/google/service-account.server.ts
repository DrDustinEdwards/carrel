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
 * The index takes metadata, and search asks Drive each time. drive.readonly is for one thing, the export of a Doc in
 * the index (Drive's files.export, which no narrower scope allows); the allowlist below lets nothing else through.
 * `documents` is the Docs API's one scope that can write, which suggestions and comments need; docBatchProblem below
 * keeps it to those. `presentations` and `spreadsheets` are the same for Slides and Sheets (the Docs plan, slice 9):
 * slidesBatchProblem, sheetsBatchProblem and the values wall below keep them to comments, a slide's text on the
 * Owner's ask, and tabs Carrel made.
 */
export const SA_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets",
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

// Every request the service account may make: listing files (metadata), exporting one Doc as Markdown, Word, PDF or
// plain text, Search Console's list of properties and its query (a POST that reads), the Docs, Slides and Sheets APIs'
// read and batchUpdate on one file, and a Sheets values write to one range. Not
// Drive's files.get, whose alt=media returns any file's content. A batchUpdate also passes docBatchProblem.
export const EXPORT_TYPES = {
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  txt: "text/plain",
} as const;
const EXPORT_MIME = Object.values(EXPORT_TYPES)
  .map((t) => encodeURIComponent(t).replace(/[.]/g, "\\."))
  .join("|");
const ALLOWED: { method: string; url: RegExp }[] = [
  { method: "GET", url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/files(\?|$)/ },
  {
    method: "GET",
    url: new RegExp(
      `^https://www\\.googleapis\\.com/drive/v3/files/[A-Za-z0-9_-]{10,100}/export\\?mimeType=(${EXPORT_MIME})$`,
    ),
  },
  // Awareness (watch.server.ts): one channel on the service account's own change log, and stopping the one it replaces.
  {
    method: "GET",
    url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\/startPageToken(\?|$)/,
  },
  {
    method: "POST",
    url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\/watch\?pageToken=[A-Za-z0-9_-]{1,200}$/,
  },
  { method: "POST", url: /^https:\/\/www\.googleapis\.com\/drive\/v3\/channels\/stop$/ },
  // Search Console: the list of properties the account is a user on (no ids, no data), and the query, a POST that reads.
  { method: "GET", url: /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites$/ },
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
  {
    method: "GET",
    url: /^https:\/\/slides\.googleapis\.com\/v1\/presentations\/[A-Za-z0-9_-]{10,100}(\?|$)/,
  },
  {
    method: "POST",
    url: /^https:\/\/slides\.googleapis\.com\/v1\/presentations\/[A-Za-z0-9_-]{10,100}:batchUpdate$/,
  },
  {
    method: "GET",
    url: /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[A-Za-z0-9_-]{10,100}(\?|$)/,
  },
  {
    method: "GET",
    url: /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[A-Za-z0-9_-]{10,100}\/values:batchGet\?/,
  },
  {
    method: "POST",
    url: /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[A-Za-z0-9_-]{10,100}:batchUpdate$/,
  },
  {
    method: "PUT",
    url: /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[A-Za-z0-9_-]{10,100}\/values\/[^?]+\?valueInputOption=RAW$/,
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

/**
 * `direct` is the Owner's own ask, checked by the caller: a text change or an accept that is not a suggestion.
 * `tab` is the title of a Sheets tab Carrel made, the one tab a values write or addSheet may name.
 */
export type DocWrite = { direct?: boolean; tab?: string };

/** The request names of a batch, or why it is not one: each names exactly one change, all of one kind. */
function oneKind(body: unknown, kinds: string[][]): { names: string[]; kind: string[] } | string {
  const batch = body as { requests?: Record<string, unknown>[] };
  if (!batch || !Array.isArray(batch.requests) || batch.requests.length === 0)
    return "a batch needs requests";
  const kindsOf = batch.requests.map((r) => Object.keys(r ?? {}));
  if (kindsOf.some((k) => k.length !== 1)) return "each request names exactly one change";
  const names = kindsOf.map((k) => k[0]!);
  const used = kinds.filter((kind) => names.some((n) => kind.includes(n)));
  if (names.some((n) => !kinds.flat().includes(n)) || used.length !== 1)
    return `only ${kinds.flat().join(", ")} are allowed, and the kinds are not mixed`;
  return { names, kind: used[0]! };
}

const NO_ASSIGNEE = "a comment never names an assignee: that emails someone";
const assigns = (body: unknown) => /"assignee(Email(Address)?)?"/.test(JSON.stringify(body));

function docBatchProblem(body: unknown, opts: DocWrite = {}): string | null {
  const one = oneKind(body, DOC_KINDS);
  if (typeof one === "string") return one;
  const suggest =
    (body as { writeControl?: { writeMode?: string } }).writeControl?.writeMode === "SUGGEST";
  if (one.kind === DOC_TEXT_REQUESTS) {
    if (!suggest && !opts.direct)
      return "a change to a Doc's text goes only as a suggestion (writeMode SUGGEST), unless it is the Owner's own ask";
    if (suggest && opts.direct) return "a direct write does not go in suggest mode";
    return null;
  }
  if (suggest) return "only text changes go in suggest mode";
  if (one.names.includes("acceptSuggestion") && !opts.direct)
    return "accepting a suggestion is the Owner's own ask";
  return assigns(body) ? NO_ASSIGNEE : null;
}

// Slides has no suggest mode, so a slide's text changes only on the Owner's own ask (`direct`); comments go as in Docs.
const SLIDES_TEXT_REQUESTS = ["deleteText", "insertText"];
const SLIDES_KINDS = [SLIDES_TEXT_REQUESTS, DOC_COMMENT_REQUESTS, DOC_DELETE_REQUESTS];

function slidesBatchProblem(body: unknown, opts: DocWrite = {}): string | null {
  const one = oneKind(body, SLIDES_KINDS);
  if (typeof one === "string") return one;
  if (one.kind === SLIDES_TEXT_REQUESTS)
    return opts.direct ? null : "a change to a slide's text is the Owner's own ask";
  return assigns(body) ? NO_ASSIGNEE : null;
}

// Sheets: never a change to his cells. A batch adds one tab (titled `opts.tab`, which Carrel makes) or comments.
const SHEETS_KINDS = [["addSheet"], DOC_COMMENT_REQUESTS, DOC_DELETE_REQUESTS];

function sheetsBatchProblem(body: unknown, opts: DocWrite = {}): string | null {
  const one = oneKind(body, SHEETS_KINDS);
  if (typeof one === "string") return one;
  if (one.kind === SHEETS_KINDS[0]) {
    const adds = (body as { requests: { addSheet?: { properties?: { title?: string } } }[] })
      .requests;
    return adds.length === 1 && opts.tab && adds[0]!.addSheet?.properties?.title === opts.tab
      ? null
      : "a new tab is added only under the title Carrel chose, one at a time";
  }
  return assigns(body) ? NO_ASSIGNEE : null;
}

/** A values write names a range on the one tab Carrel made, and nothing else. */
function valuesProblem(url: string, opts: DocWrite): string | null {
  const range = decodeURIComponent(new URL(url).pathname.split("/values/")[1] ?? "");
  const tab = opts.tab?.replace(/'/g, "''");
  return tab && range.startsWith(`'${tab}'!`)
    ? null
    : "cells are written only on a tab Carrel made, never over his data";
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
  const host = new URL(url).hostname;
  const problem = url.endsWith(":batchUpdate")
    ? (host === "slides.googleapis.com"
        ? slidesBatchProblem
        : host === "sheets.googleapis.com"
          ? sheetsBatchProblem
          : docBatchProblem)(body, opts)
    : m === "PUT"
      ? valuesProblem(url, opts)
      : null;
  if (problem) throw new ServiceAccountRefused(m, url, problem);
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
