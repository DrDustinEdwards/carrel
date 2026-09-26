// The sites Carrel reaches through site-api, and the client for one. A site's origin is config and
// its key is a secret; Carrel holds nothing else about a site and never reads its repository.

import { createSiteClient, type SiteClient } from "@dustinedwards/site-api/client";
import { MIN_KEY_LENGTH } from "@dustinedwards/site-api";

export type SiteId = "dustinedwards";

type SiteEntry = {
  name: string;
  origin: (env: Env) => string | undefined;
  key: (env: Env) => string | undefined;
  keyName: string;
  /** The source a new item starts from, in the site's own frontmatter. The site validates it on save. */
  newSource: (slug: string, today: string) => string;
};

const SITES: Record<SiteId, SiteEntry> = {
  dustinedwards: {
    name: "dustinedwards.info",
    origin: (env) => env.SITE_DUSTINEDWARDS_ORIGIN,
    key: (env) => env.SITE_DUSTINEDWARDS_KEY,
    keyName: "SITE_DUSTINEDWARDS_KEY",
    // The shape of content/posts/*.md on the site: draft until the Owner publishes.
    newSource: (slug, today) =>
      ["---", 'title: ""', `slug: ${slug}`, 'description: ""', `date: ${today}`, "tags: []", "draft: true", "---", "", ""].join("\n"),
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

export class SiteNotConnected extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "SiteNotConnected";
  }
}

/** Throws SiteNotConnected when the site cannot be reached, so callers show why instead of a 500. */
export function siteClient(env: Env, id: SiteId, fetcher?: typeof fetch): SiteClient {
  const connection = siteConnection(env, id);
  if (connection.state !== "connected") throw new SiteNotConnected(connection.detail);
  return createSiteClient({ baseUrl: connection.origin, key: connection.key, fetch: fetcher });
}
