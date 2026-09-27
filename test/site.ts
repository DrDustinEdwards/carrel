// A site for the tests: site-api's own handler over its reference adapter, reached through an
// injected fetch at the configured origin. Carrel's code runs unchanged against it.

import { createSiteApi, type SiteAdapter } from "@dustinedwards/site-api";
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

export async function viewerFor(email: string): Promise<Viewer> {
  const row = await testEnv.DB.prepare("SELECT id, email, name, is_owner, is_reviewer FROM people WHERE email = ?")
    .bind(email)
    .first<{ id: number; email: string; name: string; is_owner: number; is_reviewer: number }>();
  return { id: row!.id, email: row!.email, name: row!.name, isOwner: row!.is_owner === 1, isReviewer: row!.is_reviewer === 1 };
}
