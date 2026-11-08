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

import {
  runMediaIntent,
  type ContentSource,
  type IntentResult,
} from "@dustinedwards/site-api/admin";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { bareType, CROPPABLE } from "capsomer/behavior/media";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import { answer, kitBase } from "~/lib/kit.server";
import { requireSiteProject, type SiteProject } from "~/lib/projects.server";
import { siteClient, siteUnreachable } from "~/lib/sites.server";

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
export function usageHref(slug: string, use: { type: string; id: string }): string {
  return use.type === "post"
    ? `/p/${encodeURIComponent(slug)}/e/${encodeURIComponent(use.id)}`
    : "";
}

/**
 * One site's media, as the content kit reads and writes it for this person. Every action the site
 * carried out is one row in the authorship record, under the change id Carrel sent the site, so the
 * two histories join; a refused action writes nothing.
 */
export function mediaSource(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  fetcher?: typeof fetch,
): ContentSource {
  return {
    ...kitBase(env, project),
    client: siteClient(env, project.site, fetcher),
    editorHref: (id) => usageHref(project.slug, { type: "post", id }),
    async record({ kind, ids, changeId }) {
      const action = ACTIONS[kind];
      if (!action) return;
      await drizzle(env.DB)
        .insert(changes)
        .values(
          ids.map((itemId) => ({
            id: ids.length === 1 ? changeId : `${changeId}:${itemId}`,
            projectId: project.id,
            itemId,
            personId: viewer.id,
            action,
          })),
        );
    },
  };
}

/** The library source of the project a session names, once it may at least read the project. */
async function mediaSourceFor(env: Env, viewer: Viewer, slug: string, fetcher?: typeof fetch) {
  const project = await requireSiteProject(env.DB, viewer, slug, "read");
  return mediaSource(env, project, viewer, fetcher);
}

/**
 * A file's bytes, read from where the site serves it, for the crop editor: through Carrel, so the
 * browser draws a same-origin image it may export. Only a raster the site lists, and no larger than
 * the site's own upload limit.
 */
export async function mediaBytes(
  source: ContentSource,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const { capabilities } = await source.client.meta();
  const limit = capabilities.mediaUpload?.maxBytes ?? 0;
  const detail = capabilities.media ? await source.client.media.get(id).catch(() => null) : null;
  if (!detail || !CROPPABLE.includes(bareType(detail.contentType)) || detail.bytes > limit)
    return null;
  const src = detail.url.startsWith("/")
    ? `${source.site.origin.replace(/\/+$/, "")}${detail.url}`
    : detail.url;
  const response = await fetcher(src);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  return bytes.byteLength > limit ? null : { bytes, type: bareType(detail.contentType) };
}

/** A site that is not connected or cannot be reached, said plainly instead of a crash. null for anything else. */
export function unreachable(error: unknown): string | null {
  if (error instanceof SiteApiError && error.status === 501)
    return "This site has no media library yet.";
  return siteUnreachable(error);
}

/** One posted intent, as the kit runs it. The same for this page's forms with no script and the media endpoint's. */
export async function runIntent(
  env: Env,
  viewer: Viewer,
  slug: string | undefined,
  form: FormData,
): Promise<IntentResult> {
  const project = await requireSiteProject(env.DB, viewer, slug, "read");
  return answer(() => runMediaIntent(mediaSource(env, project, viewer), form), unreachable);
}

/** The most files one delete call takes; the kit's own per-request count holds too. */
export const DELETE_LIMIT = 25;

/**
 * Deletes library files for good for an AI session, through the same kit steps as the Desk's buttons: a file is moved to
 * the trash first where the site has one, then deleted with the count typed as the confirmation. The kit refuses a person
 * who is not the Owner and the site refuses a file a page still uses, so each file ends as deleted or refused, named.
 */
export async function deleteMediaFiles(
  env: Env,
  viewer: Viewer,
  slug: string,
  ids: string[],
  fetcher?: typeof fetch,
): Promise<IntentResult> {
  const source = await mediaSourceFor(env, viewer, slug, fetcher);
  return answer(async () => {
    const offers = (await source.client.meta()).capabilities;
    if (offers.mediaTrash) {
      for (const id of ids) {
        const detail = await source.client.media.get(id).catch(() => null);
        if (!detail || detail.trashedAt) continue;
        const trashed = await runMediaIntent(source, {
          intent: "trash",
          ids: [id],
          versions: [detail.version ?? ""],
        });
        if (!trashed.ok) return trashed;
      }
    }
    return runMediaIntent(source, { intent: "delete", ids, confirm: String(ids.length) });
  }, unreachable);
}

/**
 * Brings a picture into a site's library from its https address, for an AI session, through the Desk's own Import: the
 * site fetches and checks it, shrinks it as an upload would be, and a file already stored is reported, not stored twice.
 */
export async function importMediaFile(
  env: Env,
  viewer: Viewer,
  slug: string,
  input: { url: string; alt: string; filename?: string },
  fetcher?: typeof fetch,
): Promise<IntentResult> {
  const source = await mediaSourceFor(env, viewer, slug, fetcher);
  return answer(
    () =>
      runMediaIntent(source, {
        intent: "import",
        url: input.url,
        alt: input.alt,
        filename: input.filename ?? "",
      }),
    unreachable,
  );
}

/** The most files one list call returns, each with the pages that use it. */
export const MEDIA_PAGE = 25;

/** The lenses a list can open on (site-api's MEDIA_LENSES); the default is the files with no alt text. */
export const MEDIA_LENS_NAMES = [
  "no-alt",
  "unattached",
  "large",
  "duplicates",
  "license-expired",
  "oversized",
] as const;

/**
 * A page of a site's library for an AI session: by default the files with no alt text (and not marked decorative), each
 * with where it is used, its size and its address, so a session can look at the picture and write the alt. Read only.
 */
export async function listMediaFiles(
  env: Env,
  viewer: Viewer,
  slug: string,
  query: { lens?: string; q?: string; cursor?: string },
  fetcher?: typeof fetch,
): Promise<
  | {
      ok: true;
      lens: string;
      total: number | null;
      files: Record<string, unknown>[];
      next_cursor: string | null;
    }
  | { ok: false; message: string }
> {
  const source = await mediaSourceFor(env, viewer, slug, fetcher);
  const lens = query.lens ?? "no-alt";
  try {
    const list = await source.client.media.list({
      lens: lens as (typeof MEDIA_LENS_NAMES)[number],
      limit: MEDIA_PAGE,
      ...(query.q ? { q: query.q } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const origin = source.site.origin.replace(/\/+$/, "");
    const files = await Promise.all(
      list.items.map(async (item) => {
        const detail = await source.client.media.get(item.id).catch(() => null);
        return {
          id: item.id,
          filename: item.filename,
          contentType: item.contentType,
          width: item.width,
          height: item.height,
          alt: item.alt,
          decorative: item.decorative === true,
          caption: item.caption ?? "",
          url: item.url.startsWith("/") ? `${origin}${item.url}` : item.url,
          version: item.version ?? detail?.version ?? null,
          usedBy: (detail?.usedBy ?? []).map((use) => ({
            type: use.type,
            id: use.id,
            title: use.title,
            detail: use.detail,
          })),
        };
      }),
    );
    return {
      ok: true,
      lens,
      total: list.total ?? null,
      files,
      next_cursor: list.nextCursor,
    };
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return { ok: false, message };
  }
}

/**
 * What the site's own suggester (site-api's mediaSuggester, behind the media group's `suggestions`) writes as one file's
 * alt text. Nothing is written: the caller decides, through setMediaAlt.
 */
export async function suggestMediaAlt(
  env: Env,
  viewer: Viewer,
  slug: string,
  id: string,
  fetcher?: typeof fetch,
): Promise<
  | {
      ok: true;
      alt: string | null;
      model: string;
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }
  | { ok: false; message: string }
> {
  const source = await mediaSourceFor(env, viewer, slug, fetcher);
  try {
    const made = await source.client.media.suggestions(id);
    return { ok: true, alt: made.alt, model: made.model, usage: made.usage };
  } catch (error) {
    const message = unreachable(error);
    if (message !== null) return { ok: false, message };
    if (error instanceof SiteApiError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * Writes the alt text of one library file for an AI session, or marks it decorative, through the Desk's own alt step: the
 * site refuses an alt that is the file name, a bare word such as "image", an address, or too long, and refuses an alt sent
 * with decorative. The version is read first so a file changed in between is refused, not overwritten.
 */
export async function setMediaAlt(
  env: Env,
  viewer: Viewer,
  slug: string,
  input: { id: string; alt: string; decorative: boolean },
  fetcher?: typeof fetch,
): Promise<IntentResult> {
  const source = await mediaSourceFor(env, viewer, slug, fetcher);
  return answer(async () => {
    const detail = await source.client.media.get(input.id).catch(() => null);
    if (!detail) return { ok: false, message: `No file ${input.id} in this site's library.` };
    return runMediaIntent(source, {
      intent: "alt",
      ids: [input.id],
      versions: [detail.version ?? ""],
      alt: input.alt,
      ...(input.decorative ? { decorative: "yes" } : {}),
    });
  }, unreachable);
}
