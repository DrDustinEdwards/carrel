// Search Console per page (design section 5, "Insight"), read by the service account, which Dustin
// adds as a user on each property. Fetched at most once a day, since Google's data moves daily and
// lags two to three days; the editor shows the post's own row.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { searchConsolePages } from "~/db/schema";
import type { SiteProject } from "~/lib/projects.server";
import { siteConnection, siteEntry, type SiteId } from "~/lib/sites.server";

import { saClient } from "./service-account.server";

type Fetch = typeof fetch;

const DAY = 24 * 60 * 60 * 1000;
/** Google's data settles a few days after the fact; the window ends before the unsettled days. */
const LAG_DAYS = 3;
const WINDOW_DAYS = 28;

/** The Search Console property for a site: a domain property unless a var says otherwise. */
export function propertyFor(env: Env, site: SiteId): string {
  return siteEntry(site).searchConsoleProperty(env);
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type ScRefresh = { pages: number; skipped: boolean; start: string; end: string };

export async function refreshSearchConsole(env: Env, project: { id: number; site: SiteId }, fetcher?: Fetch, now = new Date()): Promise<ScRefresh> {
  const d = drizzle(env.DB);
  const last = await d.select({ fetchedAt: searchConsolePages.fetchedAt }).from(searchConsolePages).where(eq(searchConsolePages.projectId, project.id)).get();
  const end = day(new Date(now.getTime() - LAG_DAYS * DAY));
  const start = day(new Date(now.getTime() - (LAG_DAYS + WINDOW_DAYS - 1) * DAY));
  if (last && now.getTime() - Date.parse(last.fetchedAt) < DAY) return { pages: 0, skipped: true, start, end };

  const property = propertyFor(env, project.site);
  const sa = saClient(env, fetcher);
  const res = await sa.request("POST", `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    startDate: start,
    endDate: end,
    dimensions: ["page"],
    rowLimit: 25000,
    dataState: "final",
  });
  if (!res.ok) {
    const hint = res.status === 403 ? " Add the service account as a user on the property in Search Console." : "";
    throw new Error(`Search Console refused the query for ${property} (${res.status}).${hint}`);
  }
  const body = (await res.json()) as { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] };
  const at = now.toISOString();
  await d.delete(searchConsolePages).where(eq(searchConsolePages.projectId, project.id));
  for (const r of body.rows ?? []) {
    await d.insert(searchConsolePages).values({
      projectId: project.id,
      page: r.keys[0] ?? "",
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: r.ctr,
      position: r.position,
      startDate: start,
      endDate: end,
      fetchedAt: at,
    });
  }
  return { pages: body.rows?.length ?? 0, skipped: false, start, end };
}

/** The post's row, found by its full URL on the site. */
export async function pageStats(env: Env, project: SiteProject, path: string | null) {
  const connection = siteConnection(env, project.site);
  if (!path || connection.state !== "connected") return null;
  const url = new URL(path, connection.origin).href;
  return (
    (await drizzle(env.DB)
      .select()
      .from(searchConsolePages)
      .where(and(eq(searchConsolePages.projectId, project.id), eq(searchConsolePages.page, url)))
      .get()) ?? null
  );
}
