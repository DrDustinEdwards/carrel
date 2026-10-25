// The search and sharing checks (seo-checks.ts) for a page or a tool that has a project and an item but not
// the editor's loader data: the site's origin from its connection, and the item's kind and address from the index.

import { searchItems, sitePaths } from "~/lib/index.server";
import type { SiteProject } from "~/lib/projects.server";
import { seoCheck, type SeoCheck } from "~/lib/seo-checks";
import { siteConnection } from "~/lib/sites.server";

/**
 * The checks on `source` as item `id` of the project. The kind and path are the site's own when the caller
 * read the item; otherwise the index's, and for a draft not yet published, the path its published siblings
 * show. With no id (text checked before it has one) the text is a post with no address yet.
 */
export async function seoOf(env: Env, project: SiteProject, source: string, item: { id: string | null; kind?: string | null; path?: string | null }): Promise<SeoCheck | null> {
  const connection = siteConnection(env, project.site);
  const indexed = item.id && (item.kind === undefined || !item.path) ? await searchItems(env.DB, project.id, {}) : [];
  const kind = item.kind !== undefined ? item.kind : (indexed.find((i) => i.itemId === item.id)?.kind ?? null);
  const path = item.path || (item.id ? (sitePaths(indexed).get(item.id) ?? null) : null);
  return seoCheck(project.site, source, { kind, origin: connection.state === "connected" ? connection.origin : null, path });
}
