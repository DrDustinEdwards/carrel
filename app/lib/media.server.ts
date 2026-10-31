// The media library over the site API's media group, through the content kit (site-api's admin
// half): Carrel and every site's own admin run the same loader and the same intents, and the screen
// is Capsomer's MediaLibrary. Files stay in the site's own storage and are served by the site; the
// site's reference check decides every delete, and Carrel shows its answer.
//
// Roles, as the kit reads them from Carrel's: a Reader browses (and sees live what others changed),
// an Editor also uploads or imports from a web address (and inserts into a post), edits alt text,
// caption, credit and license, tags and the focal point, and moves files to the trash and back (all
// reversible), and only the Owner deletes for good, empties the trash, or changes a file's bytes under
// its address: replace, turn or mirror, go back to an earlier version, shrink (each changes every page
// that shows it). The kit refuses a step the person may not take before the site hears anything.
// The site's model suggests tags and alt text only when an Editor or the Owner asks (Suggest, the
// query's suggest=1), and each suggestion is applied only when the person accepts it, as an ordinary
// tag-add or alt post: nothing the model says is written unasked.

import { runMediaIntent, type ContentSource, type IntentResult } from "@dustinedwards/site-api/admin";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { bareType, CROPPABLE } from "capsomer/behavior/media";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import { answer, kitBase } from "~/lib/kit.server";
import { requireSiteProject, type SiteProject } from "~/lib/projects.server";
import { actorOf, siteClient, siteUnreachable } from "~/lib/sites.server";

/** The authorship record's action for each kind the kit records (migration 0007 and later; site-api v0.13's in 0024). */
const ACTIONS: Record<string, (typeof changes.$inferInsert)["action"]> = {
  "media-upload": "media-upload",
  "media-delete": "media-delete",
  "media-alt": "media-alt",
  "media-tags": "media-tags",
  "media-tag-add": "media-tags",
  "media-tag-remove": "media-tags",
  "media-trash": "media-trash",
  "media-restore": "media-restore",
  "media-focus": "media-focus",
  "media-caption": "media-caption",
  "media-replace": "media-replace",
  "media-import": "media-import",
  "media-credit": "media-credit",
  "media-transform": "media-transform",
  "media-revert": "media-revert",
  "media-resize": "media-resize",
};

/** Where a place that uses a file opens in Carrel: a post opens in its editor. */
export function useHref(slug: string, use: { type: string; id: string }): string {
  return use.type === "post" ? `/p/${encodeURIComponent(slug)}/e/${encodeURIComponent(use.id)}` : "";
}

/**
 * One site's media, as the content kit reads and writes it for this person. Every action the site
 * carried out is one row in the authorship record, under the change id Carrel sent the site, so the
 * two histories join; a refused action writes nothing.
 */
export function mediaSource(env: Env, project: SiteProject, viewer: Viewer, fetcher?: typeof fetch): ContentSource {
  return {
    ...kitBase(env, project),
    client: siteClient(env, project.site, fetcher, actorOf(viewer)),
    editorHref: (id) => useHref(project.slug, { type: "post", id }),
    async record({ kind, ids, changeId }) {
      const action = ACTIONS[kind];
      if (!action) return;
      await drizzle(env.DB)
        .insert(changes)
        .values(ids.map((itemId) => ({ id: ids.length === 1 ? changeId : `${changeId}:${itemId}`, projectId: project.id, itemId, personId: viewer.id, action })));
    },
  };
}

/**
 * A file's bytes, read from where the site serves it, for the crop editor: through Carrel, so the
 * browser draws a same-origin image it may export. Only a raster the site lists, and no larger than
 * the site's own upload limit.
 */
export async function mediaBytes(source: ContentSource, id: string, fetcher: typeof fetch = fetch): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const { capabilities } = await source.client.meta();
  const limit = capabilities.mediaUpload?.maxBytes ?? 0;
  const detail = capabilities.media ? await source.client.media.get(id).catch(() => null) : null;
  if (!detail || !CROPPABLE.includes(bareType(detail.contentType)) || detail.bytes > limit) return null;
  const src = detail.url.startsWith("/") ? `${source.site.origin.replace(/\/+$/, "")}${detail.url}` : detail.url;
  const response = await fetcher(src);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > limit ? null : { bytes, type: bareType(detail.contentType) };
}

/** A site that is not connected or cannot be reached, said plainly instead of a crash. null for anything else. */
export function unreachable(error: unknown): string | null {
  if (error instanceof SiteApiError && error.status === 501) return "This site has no media library yet.";
  return siteUnreachable(error);
}

/** One posted intent, as the kit runs it. The same for this page's forms with no script and the media endpoint's. */
export async function runIntent(env: Env, viewer: Viewer, slug: string | undefined, form: FormData): Promise<IntentResult> {
  const project = await requireSiteProject(env.DB, viewer, slug, "read");
  return answer(() => runMediaIntent(mediaSource(env, project, viewer), form), unreachable);
}
