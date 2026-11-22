// Search Console per page (design section 5, "Insight"), read by the service account, which Dustin
// adds as a user on each property. Fetched at most once a day, since Google's data moves daily and
// lags two to three days; the editor shows the post's own row.
//
// A property not shared with the service account is a setup step that is Dustin's, not a failure of the job: the
// refresh skips it without asking Google for its rows, and the health check names it once (searchConsoleAccess).

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { projects, searchConsolePages } from "~/db/schema";
import type { SiteProject } from "~/lib/projects.server";
import { isSiteId, siteConnection, siteEntry } from "~/lib/sites.server";

import { saClient } from "./service-account.server";
import { isoDay } from "@drdustinedwards/site-helpers/xml";

type Fetch = typeof fetch;

const DAY = 24 * 60 * 60 * 1000;
/** Google's data settles a few days after the fact; the window ends before the unsettled days. */
const LAG_DAYS = 3;
const WINDOW_DAYS = 28;

/**
 * Each connected site's property, and whether the service account may read it: Search Console's sites.list
 * (https://developers.google.com/webmaster-tools/v1/sites/list) names every property the account is a user on, and
 * siteUnverifiedUser is no access. One request covers every site.
 */
export async function searchConsoleAccess(env: Env, fetcher?: Fetch) {
  const sa = saClient(env, fetcher);
  const res = await sa.request("GET", "https://searchconsole.googleapis.com/webmasters/v3/sites");
  if (!res.ok) throw new Error(`Search Console refused sites.list (${res.status}).`);
  const { siteEntry: entries = [] } = (await res.json()) as {
    siteEntry?: { siteUrl: string; permissionLevel: string }[];
  };
  const readable = entries
    .filter((e) => e.permissionLevel !== "siteUnverifiedUser")
    .map((e) => e.siteUrl);
  const rows = await drizzle(env.DB)
    .select({ id: projects.id, slug: projects.slug, site: projects.site })
    .from(projects)
    .all();
  const sites = [];
  for (const row of rows)
    if (isSiteId(row.site) && siteConnection(env, row.site).state === "connected") {
      const property = siteEntry(row.site).searchConsoleProperty?.(env);
      if (!property) continue;
      sites.push({ ...row, property, shared: readable.includes(property) });
    }
  return { email: sa.key.clientEmail, sites };
}

export type ScRefresh = { pages: number; skipped: boolean; start: string; end: string };

export async function refreshSearchConsole(
  env: Env,
  project: { id: number; property: string },
  fetcher?: Fetch,
  now = new Date(),
): Promise<ScRefresh> {
  const d = drizzle(env.DB);
  const last = await d
    .select({ fetchedAt: searchConsolePages.fetchedAt })
    .from(searchConsolePages)
    .where(eq(searchConsolePages.projectId, project.id))
    .get();
  const end = isoDay(new Date(now.getTime() - LAG_DAYS * DAY))!;
  const start = isoDay(new Date(now.getTime() - (LAG_DAYS + WINDOW_DAYS - 1) * DAY))!;
  if (last && now.getTime() - Date.parse(last.fetchedAt) < DAY)
    return { pages: 0, skipped: true, start, end };

  const { property } = project;
  const sa = saClient(env, fetcher);
  const res = await sa.request(
    "POST",
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      startDate: start,
      endDate: end,
      dimensions: ["page"],
      rowLimit: 25000,
      dataState: "final",
    },
  );
  if (!res.ok) throw new Error(`Search Console refused ${property} (${res.status}).`);
  const body = (await res.json()) as {
    rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
  };
  const at = now.toISOString();
  // One batch per thousand statements (a D1 batch is a transaction): a row-by-row write cost a round trip each, and a
  // site with thousands of pages ran the cron job past its two minutes with its old rows already deleted.
  const statements = [
    env.DB.prepare("DELETE FROM search_console_pages WHERE project_id = ?").bind(project.id),
    ...(body.rows ?? []).map((r) =>
      env.DB.prepare(
        "INSERT INTO search_console_pages (project_id, page, clicks, impressions, ctr, position, start_date, end_date, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, page) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, ctr = excluded.ctr, position = excluded.position, start_date = excluded.start_date, end_date = excluded.end_date, fetched_at = excluded.fetched_at",
      ).bind(
        project.id,
        r.keys[0] ?? "",
        Math.round(r.clicks),
        Math.round(r.impressions),
        r.ctr,
        r.position,
        start,
        end,
        at,
      ),
    ),
  ];
  for (let i = 0; i < statements.length; i += 1000)
    await env.DB.batch(statements.slice(i, i + 1000));
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
