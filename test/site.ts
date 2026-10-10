// A site for the tests: site-api's own handler over its reference adapter, reached through an
// injected fetch at the configured origin. Carrel's code runs unchanged against it.

import { createSiteApi, RefusedError, type SiteAdapter } from "@dustinedwards/site-api";
import { memoryAdapter } from "@dustinedwards/site-api/testing";

import type { Viewer } from "~/lib/people.server";

import { testEnv } from "./env";

export const SITE_ORIGIN = "https://site.test";
export const SITE_KEY = "carrel-test-site-key-0123456789abcdef";

export function connectedEnv(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, SITE_DUSTINEDWARDS_KEY: SITE_KEY, ...overrides };
}

export function fakeSite<A extends SiteAdapter = ReturnType<typeof memoryAdapter>>(
  adapter: A = memoryAdapter() as SiteAdapter as A,
) {
  const api = createSiteApi({ adapter, key: SITE_KEY, limiter: { limit: async () => ({ success: true }) }, log: () => {} });
  const requests: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    if (!request.url.startsWith(SITE_ORIGIN)) throw new Error(`the tests reach only the fake site, not ${request.url}`);
    return api.matches(request) ? api.handle(request) : new Response("site page", { status: 404 });
  }) as typeof globalThis.fetch;
  return { adapter, fetch, requests };
}

/**
 * The kinds dustinedwards.info reports, as its adapter does: an id "<kind>.<name>" is that kind, any
 * other id is a post. A writing kind has a page on the site once published; a data kind (the lab
 * registry) never has one, and the site refuses to write it through Carrel.
 */
export const SITE_KINDS = {
  page: (name: string) => `/${name.replaceAll("-", "/")}`,
  publication: (name: string) => `/research/publications/${name}/`,
  document: (name: string) => `/${name}.txt`,
  cv: () => "/cv",
  dictionary: () => "/software/capsid",
  roster: (name: string) => `/teaching/phage-discovery#year-${name}`,
  phage: (name: string) => `/research/phages#${name}`,
  procedure: (name: string) => `/research/protocols/${name}`,
  equipment: null,
} as const satisfies Record<string, ((name: string) => string) | null>;

/** The reference adapter with the kinds and paths of the real site, for a walk over every kind. */
export function kindedAdapter(base: ReturnType<typeof memoryAdapter> = memoryAdapter()): ReturnType<typeof memoryAdapter> {
  const split = (id: string) => {
    const dot = id.indexOf(".");
    const kind = dot > 0 ? id.slice(0, dot) : "";
    return Object.hasOwn(SITE_KINDS, kind) ? { kind: kind as keyof typeof SITE_KINDS, name: id.slice(dot + 1) } : null;
  };
  const dress = <T extends { id: string; kind: string; status: string; path: string | null; publishedAt: string | null }>(doc: T): T => {
    const k = split(doc.id);
    if (!k) return { ...doc, path: doc.path?.replace("/blog/", "/writing/") ?? null };
    const page = SITE_KINDS[k.kind];
    return { ...doc, kind: k.kind, path: page && (doc.status === "published" || doc.publishedAt) ? page(k.name) : null };
  };
  const refuseData = (id: string) => {
    const k = split(id);
    if (k && SITE_KINDS[k.kind] === null) throw new RefusedError(`The site's ${k.kind} entries are edited in the site's repository, not through Carrel.`);
  };
  const content = base.content;
  return {
    ...base,
    content: {
      ...content,
      async list(query: Parameters<typeof content.list>[0]) {
        const out = await content.list(query);
        return { ...out, items: out.items.map(dress) };
      },
      async get(id: string) {
        const doc = await content.get(id);
        return doc ? dress(doc) : null;
      },
      async saveDraft(id: string, input: Parameters<typeof content.saveDraft>[1]) {
        refuseData(id);
        return content.saveDraft(id, input);
      },
      async publish(id: string, input: Parameters<typeof content.publish>[1]) {
        refuseData(id);
        return content.publish(id, input);
      },
    },
  };
}

export async function viewerFor(email: string): Promise<Viewer> {
  const row = await testEnv.DB.prepare("SELECT id, email, name, is_owner, is_reviewer FROM people WHERE email = ?")
    .bind(email)
    .first<{ id: number; email: string; name: string; is_owner: number; is_reviewer: number }>();
  return { id: row!.id, email: row!.email, name: row!.name, isOwner: row!.is_owner === 1, isReviewer: row!.is_reviewer === 1 };
}
