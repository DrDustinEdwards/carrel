// The sites Carrel reaches through site-api, and the client for one. A site's origin is config and
// its key is a secret; Carrel holds nothing else about a site and never reads its repository.

import { createSiteClient, SiteApiError, type SiteClient } from "@dustinedwards/site-api/client";
import { MIN_KEY_LENGTH } from "@dustinedwards/site-api";
import { POST_FIELDS } from "@dustinedwards/site-api/frontmatter";
import { timedFetch } from "~/lib/timed-fetch.server";

export type SiteId = "dustinedwards" | "germomics" | "foxhound" | "foxing" | "txasm" | "julieedwards";

type SiteEntry = {
  name: string;
  origin: (env: Env) => string | undefined;
  key: (env: Env) => string | undefined;
  keyName: string;
  /**
   * The source a new item starts from, in the site's own frontmatter. The site validates it on save.
   * Absent for a site with a fixed set of items, which refuses a new id: Carrel then offers no New post.
   */
  newSource?: (slug: string, today: string) => string;
  /**
   * Items other code on the site depends on staying public. dustinedwards.info's terms are the license
   * named by the Dataset JSON-LD and the Link header on every download, so Carrel never takes them down.
   */
  keepPublic: readonly string[];
  /** The Search Console property the service account reads for the site's pages. */
  searchConsoleProperty: (env: Env) => string;
};

const SITES: Record<SiteId, SiteEntry> = {
  dustinedwards: {
    name: "dustinedwards.info",
    origin: (env) => env.SITE_DUSTINEDWARDS_ORIGIN,
    key: (env) => env.SITE_DUSTINEDWARDS_KEY,
    keyName: "SITE_DUSTINEDWARDS_KEY",
    keepPublic: ["page.terms"],
    // The shape of content/posts/*.md on the site: draft until the Owner publishes.
    newSource: (slug, today) =>
      ["---", 'title: ""', `slug: ${slug}`, 'description: ""', `date: ${today}`, "tags: []", "draft: true", "---", "", ""].join("\n"),
    searchConsoleProperty: (env) => env.SEARCH_CONSOLE_PROPERTY_DUSTINEDWARDS?.trim() || "sc-domain:dustinedwards.info",
  },
  germomics: {
    name: "Germomics",
    origin: (env) => env.SITE_GERMOMICS_ORIGIN,
    key: (env) => env.SITE_GERMOMICS_KEY,
    keyName: "SITE_GERMOMICS_KEY",
    keepPublic: [],
    // The shape of germomics's app/lib/carrel/source.ts: JSON front matter, then the body in Markdown,
    // rendered by Prelum. The id is the slug, and an item the site has not seen is created a draft.
    newSource: () => ["---", 'title: ""', 'excerpt: ""', "tags: []", "---", ""].join("\n"),
    searchConsoleProperty: (env) => (env as { SEARCH_CONSOLE_PROPERTY_GERMOMICS?: string }).SEARCH_CONSOLE_PROPERTY_GERMOMICS?.trim() || "sc-domain:germomics.com",
  },
  foxhound: {
    name: "Foxhound",
    origin: (env) => env.SITE_FOXHOUND_ORIGIN,
    key: (env) => env.SITE_FOXHOUND_KEY,
    keyName: "SITE_FOXHOUND_KEY",
    keepPublic: [],
    // The shape of foxhound's app/lib/carrel/source.ts: one JSON value per front matter line, then the
    // post's Markdown body. The slug is the address given here; the site refuses a later change to it.
    newSource: (slug) =>
      ["---", 'title: ""', `slug: ${JSON.stringify(slug)}`, 'excerpt: ""', 'author: "Foxhound"', "tags: []", "featured: false", "---", ""].join("\n"),
    searchConsoleProperty: (env) => (env as { SEARCH_CONSOLE_PROPERTY_FOXHOUND?: string }).SEARCH_CONSOLE_PROPERTY_FOXHOUND?.trim() || "sc-domain:foxhoundapp.com",
  },
  foxing: {
    name: "Foxing",
    origin: (env) => env.SITE_FOXING_ORIGIN,
    key: (env) => env.SITE_FOXING_KEY,
    keyName: "SITE_FOXING_KEY",
    keepPublic: [],
    // The shape of foxing's apps/web/app/lib/carrel/journal-source.ts for a Journal post: every field
    // as JSON, a blank line, then the Markdown body. The id is the slug; a new post is created a draft.
    newSource: () =>
      ["---", 'title: ""', "excerpt: null", "cover_image_url: null", "cover_image_alt: null", "tags: []", "featured: false", "---", "", ""].join("\n"),
    searchConsoleProperty: (env) => (env as { SEARCH_CONSOLE_PROPERTY_FOXING?: string }).SEARCH_CONSOLE_PROPERTY_FOXING?.trim() || "sc-domain:foxing.app",
  },
  txasm: {
    name: "Texas Branch ASM",
    origin: (env) => env.SITE_TXASM_ORIGIN,
    key: (env) => env.SITE_TXASM_KEY,
    keyName: "SITE_TXASM_KEY",
    keepPublic: ["home", "award-nominations"],
    searchConsoleProperty: (env) => env.SEARCH_CONSOLE_PROPERTY_TXASM?.trim() || "sc-domain:txasm.org",
  },
  julieedwards: {
    name: "julieedwards.info",
    origin: (env) => env.SITE_JULIEEDWARDS_ORIGIN,
    key: (env) => env.SITE_JULIEEDWARDS_KEY,
    keyName: "SITE_JULIEEDWARDS_KEY",
    keepPublic: ["profile", "priorities", "about", "experience", "contact", "site"],
    searchConsoleProperty: (env) => env.SEARCH_CONSOLE_PROPERTY_JULIEEDWARDS?.trim() || "sc-domain:julieedwards.info",
  },
};

export const SITE_IDS = Object.keys(SITES) as SiteId[];

export function isSiteId(value: string | null | undefined): value is SiteId {
  return typeof value === "string" && Object.hasOwn(SITES, value);
}

export function siteEntry(id: SiteId): SiteEntry {
  return SITES[id];
}

export type SiteConnection =
  | { state: "connected"; origin: string; key: string }
  | { state: "not-connected"; detail: string }
  | { state: "misconfigured"; detail: string };

/**
 * No key is "not connected": the site's stage has not arrived (setup step 10). A key without an
 * origin, a short key, or a malformed origin is misconfigured, which the health check reports.
 */
export function siteConnection(env: Env, id: SiteId): SiteConnection {
  const entry = SITES[id];
  const key = entry.key(env)?.trim() ?? "";
  const origin = entry.origin(env)?.trim() ?? "";
  if (!key) return { state: "not-connected", detail: `No ${entry.keyName} set.` };
  if (key.length < MIN_KEY_LENGTH) {
    return { state: "misconfigured", detail: `${entry.keyName} is shorter than ${MIN_KEY_LENGTH} characters.` };
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { state: "misconfigured", detail: `The origin for ${entry.name} is missing or not a URL.` };
  }
  if (url.protocol !== "https:") {
    return { state: "misconfigured", detail: `The origin for ${entry.name} is not https.` };
  }
  return { state: "connected", origin: url.origin, key };
}

/**
 * Where a browser loads a site's file from. The site gives a path on itself (/media/...) or a full
 * https URL; a path is made absolute on the site's origin, since Carrel is a different host. The
 * Markdown keeps the site's own form, which is what the site serves and its reference check reads.
 */
export function absoluteMediaUrl(origin: string, url: string): string {
  return url.startsWith("/") ? `${origin.replace(/\/+$/, "")}${url}` : url;
}

/** Every configured site origin, for the image policy: a thumbnail loads from the site that serves it. */
export function siteOrigins(env: Env): string[] {
  const origins: string[] = [];
  for (const id of SITE_IDS) {
    try {
      const url = new URL(SITES[id].origin(env)?.trim() ?? "");
      if (url.protocol === "https:") origins.push(url.origin);
    } catch {
      // Not configured: nothing of it is loaded.
    }
  }
  return origins;
}

export class SiteNotConnected extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "SiteNotConnected";
  }
}

/** Who a write is by, as the site credits it (site-api v0.19.0 `actor`): the signed-in person's display name. */
export type Actor = { name: string };

/**
 * The writes that carry the actor: a JSON body under these takes `actor`; a DELETE, and an upload whose
 * body is the file, take `actorName` in the query instead. `POST /preview` is not a write and takes neither.
 */
const ACTOR_BODY = /\/api\/carrel\/v1\/(content\/|media(\/|$)|mentions\/|preview-links$)/;
const ACTOR_QUERY = /\/api\/carrel\/v1\/(content\/[^/]+(\/schedule)?|preview-links\/[^/]+|media\/[^/]+|mentions\/[^/]+)$/;
const ACTOR_UPLOAD = /\/api\/carrel\/v1\/media(\/[^/]+\/file)?$/;

/**
 * What a site's meta declares beyond the pinned site-api's own schema, which drops what it does not know.
 * TODO site-api 0.19: `backlinks`, `previewLinkHours` and the featureImage post fields are in its Meta;
 * read them from `client.meta()` and drop this.
 */
export type SiteExtras = { postFields: string[]; backlinks: boolean; previewLinkHoursMax: number | null };
const EXTRAS = new WeakMap<object, { caps: Record<string, unknown> | null }>();

/**
 * The fetch every site client sends through. A write is credited to the person (site-api v0.19.0; an
 * older site drops the field). Meta is read once as sent, for `siteExtras`, and a post field the
 * pinned contract does not know yet is left out of what it parses, so a newer site does not break it.
 */
function siteFetch(base: typeof fetch, actor: Actor | undefined, seen: { caps: Record<string, unknown> | null }): typeof fetch {
  // The client calls fetch(url, init) with a string or Blob body. The call is passed on in that form, never
  // as a Request: a fetch that reads a Request (a test's, a harness's) would find its body already used.
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const json = new Headers(init?.headers).get("content-type") === "application/json";
    const name = actor?.name.trim().slice(0, 200);
    let call: Parameters<typeof fetch> = [input, init];
    if (name && ((method === "DELETE" && ACTOR_QUERY.test(url.pathname)) || (method !== "GET" && !json && init?.body && ACTOR_UPLOAD.test(url.pathname)))) {
      url.searchParams.set("actorName", name);
      call = [url.toString(), init];
    } else if (name && method !== "GET" && json && typeof init?.body === "string" && ACTOR_BODY.test(url.pathname)) {
      call = [input, { ...init, body: JSON.stringify({ ...(JSON.parse(init.body) as Record<string, unknown>), actor: { name } }) }];
    }
    const response = await base(...call);
    if (method !== "GET" || !url.pathname.endsWith("/api/carrel/v1/meta") || !response.ok) return response;
    const text = await response.text();
    let meta: { capabilities?: Record<string, unknown> };
    try {
      meta = JSON.parse(text) as typeof meta;
    } catch {
      return new Response(text, response);
    }
    seen.caps = meta.capabilities ?? null;
    const fields = meta.capabilities?.postFields;
    if (!Array.isArray(fields) || fields.every((f) => (POST_FIELDS as readonly unknown[]).includes(f))) return new Response(text, response);
    const known = fields.filter((f) => (POST_FIELDS as readonly unknown[]).includes(f));
    return Response.json({ ...meta, capabilities: { ...meta.capabilities, postFields: known } }, { status: response.status });
  };
}

/** Throws SiteNotConnected when the site cannot be reached, so callers show why instead of a 500. `actor` is who its writes are by. */
export function siteClient(env: Env, id: SiteId, fetcher?: typeof fetch, actor?: Actor): SiteClient {
  const connection = siteConnection(env, id);
  if (connection.state !== "connected") throw new SiteNotConnected(connection.detail);
  const seen = { caps: null };
  const client = createSiteClient({ baseUrl: connection.origin, key: connection.key, fetch: siteFetch(fetcher ?? timedFetch, actor, seen) });
  EXTRAS.set(client, seen);
  return client;
}

/** The actor for a person: their display name, or none when they have not set one (an address is not a name to publish). */
export const actorOf = (viewer: { name: string }): Actor | undefined => (viewer.name.trim() ? { name: viewer.name.trim() } : undefined);

/** What the client's last `meta()` declared beyond its contract (see SiteExtras). Empty before one. */
export function siteExtras(client: SiteClient): SiteExtras {
  const caps = EXTRAS.get(client)?.caps ?? {};
  const hours = caps.previewLinkHours as { max?: unknown } | undefined;
  return {
    postFields: Array.isArray(caps.postFields) ? caps.postFields.filter((f): f is string => typeof f === "string") : [],
    backlinks: caps.backlinks === true,
    previewLinkHoursMax: typeof hours?.max === "number" && Number.isInteger(hours.max) && hours.max > 0 ? hours.max : null,
  };
}

/** A site that is not connected or cannot be reached, said plainly instead of a crash. null for anything else. */
export function siteUnreachable(error: unknown): string | null {
  if (error instanceof SiteNotConnected) return `This site is not connected yet: ${error.detail}`;
  if (error instanceof SiteApiError) return error.body ? `The site refused: ${error.body.message}` : `The site answered ${error.status}.`;
  return null;
}

export type Backlink = { id: string; title: string; path: string | null };

/**
 * The posts that link to this one, where the site declares `backlinks` (site-api v0.19.0,
 * `GET /content/:id/backlinks`). TODO site-api 0.19: use the client's own `backlinks(id)` and drop this.
 */
export async function siteBacklinks(env: Env, id: SiteId, itemId: string, fetcher?: typeof fetch): Promise<Backlink[]> {
  const connection = siteConnection(env, id);
  if (connection.state !== "connected") throw new SiteNotConnected(connection.detail);
  const response = await (fetcher ?? timedFetch)(`${connection.origin}/api/carrel/v1/content/${encodeURIComponent(itemId)}/backlinks`, {
    headers: { authorization: `Bearer ${connection.key}` },
  });
  if (!response.ok) throw new SiteApiError(response.status, null);
  const body = (await response.json()) as { items?: unknown };
  if (!Array.isArray(body.items)) return [];
  return body.items.flatMap((raw: unknown) => {
    const item = raw as { id?: unknown; title?: unknown; path?: unknown };
    return typeof item?.id === "string" ? [{ id: item.id, title: typeof item.title === "string" && item.title ? item.title : item.id, path: typeof item.path === "string" ? item.path : null }] : [];
  });
}
