// The media library over the site API's media group, through the content kit (site-api's admin
// half): Carrel and every site's own admin run the same loader and the same intents, and the screen
// is Capsomer's MediaLibrary. Files stay in the site's own storage and are served by the site; the
// site's reference check decides every delete, and Carrel shows its answer.
//
// Roles, as the kit reads them from Carrel's: a Reader browses, an Editor also uploads (and inserts
// into a post), edits alt text, caption, tags and the focal point, and moves files to the trash and
// back (all reversible), and only the Owner deletes for good, empties the trash or replaces a file's
// bytes (which changes every page that shows it, and cannot be taken back here). The kit refuses a
// step the person may not take before the site hears anything.

import { runMediaIntent, type ContentSource, type IntentResult } from "@dustinedwards/site-api/admin";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { bareType, CROPPABLE } from "capsomer/behavior/media";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import { requireSiteProject, type SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient, siteConnection, siteEntry, SiteNotConnected } from "~/lib/sites.server";

/** The authorship record's action for each kind the kit records (migration 0007 and later). */
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
  const connection = siteConnection(env, project.site);
  return {
    site: { id: project.site, name: siteEntry(project.site).name, origin: connection.state === "connected" ? connection.origin : "" },
    client: siteClient(env, project.site, fetcher),
    can: {
      edit: can(project.role, "edit"),
      publish: can(project.role, "publish"),
      deleteContent: can(project.role, "delete_content"),
      deleteMedia: can(project.role, "delete_media"),
      decideMentions: can(project.role, "decide_mention"),
    },
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
  if (error instanceof SiteNotConnected) return `This site is not connected yet: ${error.detail}`;
  if (error instanceof SiteApiError) {
    if (error.status === 501) return "This site has no media library yet.";
    return error.body ? `The site refused: ${error.body.message}` : `The site answered ${error.status}.`;
  }
  return null;
}

/** One posted intent, as the kit runs it. The same for this page's forms with no script and the media endpoint's. */
export async function runIntent(env: Env, viewer: Viewer, slug: string | undefined, form: FormData): Promise<IntentResult> {
  const project = await requireSiteProject(env.DB, viewer, slug, "read");
  try {
    return await runMediaIntent(mediaSource(env, project, viewer), form);
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
}
