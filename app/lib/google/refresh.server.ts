// The cron's Google work: the manuscripts index (so files added to the folder appear) and each
// site's Search Console rows (at most daily). Nothing runs until the service account is set up; a
// failure is logged, and the health check is where a broken key is reported.

import { isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { projects } from "~/db/schema";
import { isSiteId, siteConnection } from "~/lib/sites.server";

import { manuscriptsFolder, refreshManuscripts } from "./drive.server";
import { refreshSearchConsole } from "./search-console.server";
import { saConnection } from "./service-account.server";

export async function refreshGoogle(env: Env, fetcher?: typeof fetch): Promise<Record<string, unknown>> {
  if (saConnection(env).state !== "connected") return { skipped: "service account not connected" };
  const out: Record<string, unknown> = {};
  const note = (key: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ google: "refresh-failed", key, error: message }));
    out[key] = `failed: ${message}`;
  };
  if (manuscriptsFolder(env)) {
    try {
      out.manuscripts = await refreshManuscripts(env, fetcher);
    } catch (error) {
      note("manuscripts", error);
    }
  }
  const sites = await drizzle(env.DB).select({ id: projects.id, slug: projects.slug, site: projects.site }).from(projects).where(isNotNull(projects.site)).all();
  for (const row of sites) {
    if (!isSiteId(row.site) || siteConnection(env, row.site).state !== "connected") continue;
    try {
      out[`search-console:${row.slug}`] = await refreshSearchConsole(env, { id: row.id, site: row.site }, fetcher);
    } catch (error) {
      note(`search-console:${row.slug}`, error);
    }
  }
  return out;
}
