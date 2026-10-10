// What a site remembers about one item: its revisions, the source at each, and the patch between
// two. Read-only: nothing here writes to the site or to Carrel. A Reader may read all of it, so the
// check is "read", and it sits here so every door asks the same question.

import type { Revision } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";

import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient } from "~/lib/sites.server";

function requireRead(project: { role: SiteProject["role"] }) {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
}

/** A 404 from the site means it does not hold that item or version; every other failure is the caller's to show. */
async function orNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SiteApiError && error.status === 404) return null;
    throw error;
  }
}

/** Newest first, as the site gives them. null when the site does not hold the item. */
export async function listRevisions(env: Env, project: SiteProject, itemId: string, fetcher?: typeof fetch): Promise<Revision[] | null> {
  requireRead(project);
  const list = await orNull(() => siteClient(env, project.site, fetcher).revisions(itemId));
  return list ? list.items : null;
}

/** The source as it was at a version. null when the site does not hold the item or the version. */
export async function readRevision(env: Env, project: SiteProject, itemId: string, version: string, fetcher?: typeof fetch): Promise<string | null> {
  requireRead(project);
  const revision = await orNull(() => siteClient(env, project.site, fetcher).revision(itemId, version));
  return revision ? revision.source : null;
}

/** The site's own unified patch from one version to another. null when the site does not hold either. */
export async function revisionPatch(env: Env, project: SiteProject, itemId: string, from: string, to: string, fetcher?: typeof fetch): Promise<string | null> {
  requireRead(project);
  const diff = await orNull(() => siteClient(env, project.site, fetcher).diff(itemId, from, to));
  return diff ? diff.patch : null;
}

/**
 * Puts two picked versions in order, older first, by their place in the site's list (newest first).
 * null unless exactly two different versions that are both in the list were picked.
 */
export function orderPair<R extends Pick<Revision, "version"> = Revision>(revisions: readonly R[], picked: readonly string[]): { from: R; to: R } | null {
  const unique = [...new Set(picked)];
  if (unique.length !== 2) return null;
  const at = (version: string) => revisions.findIndex((r) => r.version === version);
  const [a, b] = unique as [string, string];
  if (at(a) < 0 || at(b) < 0) return null;
  const [older, newer] = at(a) > at(b) ? [a, b] : [b, a];
  return { from: revisions[at(older)]!, to: revisions[at(newer)]! };
}
