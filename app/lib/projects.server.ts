import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { projects } from "~/db/schema";
import { requireAction, type Viewer } from "~/lib/people.server";
import type { Action, Role } from "~/lib/roles";
import { isSiteId, type SiteId } from "~/lib/sites.server";

export type SiteProject = {
  id: number;
  slug: string;
  name: string;
  site: SiteId;
  role: Role;
};

/**
 * The project behind a URL, for a viewer allowed `action` on it. A project that does not exist, is
 * not shared with the viewer, or is not a site all answer 404, so a URL reveals nothing.
 */
export async function requireSiteProject(
  db: D1Database,
  viewer: Viewer,
  slug: string | undefined,
  action: Action,
): Promise<SiteProject> {
  const row = slug
    ? await drizzle(db)
        .select({ id: projects.id, slug: projects.slug, name: projects.name, site: projects.site })
        .from(projects)
        .where(eq(projects.slug, slug))
        .get()
    : undefined;
  if (!row) throw new Response("Not found", { status: 404 });
  const role = await requireAction(db, viewer, row.id, action);
  if (!isSiteId(row.site)) throw new Response("Not found", { status: 404 });
  return { id: row.id, slug: row.slug, name: row.name, site: row.site, role };
}
