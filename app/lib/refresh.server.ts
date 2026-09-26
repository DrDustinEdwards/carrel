// The cron's index refresh: every project that is a connected site. A site that is not connected yet
// is skipped quietly; one that fails is logged, and the health check is where it gets reported.

import { isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { projects } from "~/db/schema";
import { refreshIndex, type RefreshResult } from "~/lib/index.server";
import { isSiteId, siteConnection } from "~/lib/sites.server";

export async function refreshAllSites(env: Env, fetcher?: typeof fetch): Promise<Record<string, RefreshResult | string>> {
  const rows = await drizzle(env.DB)
    .select({ id: projects.id, slug: projects.slug, site: projects.site })
    .from(projects)
    .where(isNotNull(projects.site))
    .all();
  const out: Record<string, RefreshResult | string> = {};
  for (const row of rows) {
    if (!isSiteId(row.site)) continue;
    if (siteConnection(env, row.site).state !== "connected") {
      out[row.slug] = "not connected";
      continue;
    }
    try {
      out[row.slug] = await refreshIndex(env, { id: row.id, site: row.site }, fetcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ refresh: "failed", project: row.slug, error: message }));
      out[row.slug] = `failed: ${message}`;
    }
  }
  return out;
}
