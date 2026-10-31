// The search and sharing checks (seo-checks.ts) for a page or a tool that has a project and an item but not
// the editor's loader data: the site's origin from its connection, and the item's kind and address from the index.

import { searchItems, sitePaths } from "~/lib/index.server";
import type { SiteProject } from "~/lib/projects.server";
import { searchFieldsOf, splitSource, type SearchField } from "@dustinedwards/site-api/frontmatter";

import { seoCheck, type SeoCheck } from "~/lib/seo-checks";
import { siteClient, siteConnection } from "~/lib/sites.server";

/**
 * The search fields the site renders (capabilities.searchFields), asked only when the source sets one, so a
 * post without them costs no request. A site that does not answer lists none.
 */
export async function listedSearchFields(env: Env, project: SiteProject, source: string, fetcher?: typeof fetch): Promise<SearchField[]> {
  const set = Object.values(searchFieldsOf(splitSource(source.replace(/\r\n/g, "\n")).front)).some(Boolean);
  if (!set) return [];
  try {
    return (await siteClient(env, project.site, fetcher).meta()).capabilities.searchFields ?? [];
  } catch {
    return [];
  }
}

/**
 * The checks on `source` as item `id` of the project. The kind and path are the site's own when the caller
 * read the item; otherwise the index's, and for a draft not yet published, the path its published siblings
 * show. With no id (text checked before it has one) the text is a post with no address yet.
 */
export async function seoOf(env: Env, project: SiteProject, source: string, item: { id: string | null; kind?: string | null; path?: string | null }, fetcher?: typeof fetch): Promise<SeoCheck | null> {
  const connection = siteConnection(env, project.site);
  const indexed = item.id && (item.kind === undefined || !item.path) ? await searchItems(env.DB, project.id, {}) : [];
  const kind = item.kind !== undefined ? item.kind : (indexed.find((i) => i.itemId === item.id)?.kind ?? null);
  const path = item.path || (item.id ? (sitePaths(indexed).get(item.id) ?? null) : null);
  const searchFields = await listedSearchFields(env, project, source, fetcher);
  return seoCheck(project.site, source, { kind, origin: connection.state === "connected" ? connection.origin : null, path, searchFields });
}
