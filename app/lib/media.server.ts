// The media library (stage 3), over the site API's media group (site-api v0.2.0). Files stay in the
// site's own storage and are served by the site: Carrel lists them, uploads to them and asks for
// deletes, and nothing about serving an image depends on Carrel. The site's reference check decides
// every delete; Carrel shows its answer.
//
// Roles, checked here so the page and any later tool meet the same rule: a Reader browses, an Editor
// also uploads (and inserts into a post), edits alt text and tags, and moves files to the trash and
// back (all reversible), and only the Owner deletes for good or empties the trash.
//
// The writes (site-api v0.4.0) are each optional per site: the site's meta says which it offers
// (`mediaAlt`, `mediaTags`, `mediaTrash`), and the screens hide what it does not. A 501 means the same.

import type { MediaBulkInput, MediaDetail, MediaItem, MediaList, MediaUploadLimits, MediaUse } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can, type Action } from "~/lib/roles";
import { absoluteMediaUrl, siteClient, siteConnection } from "~/lib/sites.server";

function requireCan(project: SiteProject, action: Action) {
  if (!can(project.role, action)) throw new Response("Forbidden", { status: 403 });
}

/** A file as Carrel's screens show it: the site's item, plus the absolute address a browser loads. */
export type MediaView = MediaItem & { src: string };

/** Who did it: the person, and the AI client when it came through the AI door (credited in the record). */
export type MediaActor = { viewer: Viewer; client?: string };

/**
 * One row in the authorship record per media action that the site carried out (migration 0007): the
 * same change id Carrel sent the site, so the two histories join. A refused action writes nothing.
 */
type MediaAction = "media-upload" | "media-delete" | "media-alt" | "media-tags" | "media-trash" | "media-restore";

async function record(
  env: Env,
  project: SiteProject,
  actor: MediaActor,
  action: MediaAction,
  mediaId: string,
  changeId: string,
  versions: { before?: string | null; after?: string | null } = {},
) {
  await drizzle(env.DB).insert(changes).values({
    id: changeId,
    projectId: project.id,
    itemId: mediaId,
    personId: actor.viewer.id,
    action,
    versionBefore: versions.before ?? null,
    versionAfter: versions.after ?? null,
    client: actor.client ?? null,
  });
}

function view(project: SiteProject, env: Env, item: MediaItem): MediaView {
  const connection = siteConnection(env, project.site);
  const origin = connection.state === "connected" ? connection.origin : "";
  return { ...item, src: origin ? absoluteMediaUrl(origin, item.url) : item.url };
}

/** Which writes the site offers beyond upload and delete (site-api v0.4.0); a site lacking one never sees its screen. */
export type MediaOffers = { alt: boolean; tags: boolean; trash: boolean };

/** What the site accepts and which writes it offers, from its meta. null when the site offers no media (a v0.1.0 site). */
export async function mediaMeta(env: Env, project: SiteProject, fetcher?: typeof fetch): Promise<{ limits: MediaUploadLimits; offers: MediaOffers } | null> {
  requireCan(project, "read");
  const { capabilities } = await siteClient(env, project.site, fetcher).meta();
  if (!capabilities.media || !capabilities.mediaUpload) return null;
  return {
    limits: capabilities.mediaUpload,
    offers: { alt: capabilities.mediaAlt === true, tags: capabilities.mediaTags === true, trash: capabilities.mediaTrash === true },
  };
}

/** What the site accepts, from its meta. null when the site offers no media (a v0.1.0 site). */
export async function mediaLimits(env: Env, project: SiteProject, fetcher?: typeof fetch): Promise<MediaUploadLimits | null> {
  return (await mediaMeta(env, project, fetcher))?.limits ?? null;
}

/** A tag as the site spells it: lower case words joined by single hyphens, at most 32 characters. null when it cannot be one. */
export function cleanMediaTag(raw: string): string | null {
  const tag = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return tag.length > 0 && tag.length <= 32 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag) ? tag : null;
}

/** A typed list of tags (commas between them) as a file's whole tag set: unique, at most 12, or the reason it cannot be. */
export function parseMediaTags(raw: string): { ok: true; tags: string[] } | { ok: false; message: string } {
  const tags: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    if (part.trim() === "") continue;
    const tag = cleanMediaTag(part);
    if (tag === null) return { ok: false, message: `"${part.trim()}" cannot be a tag. A tag is lower case words and numbers joined by hyphens, up to 32 characters.` };
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 12) return { ok: false, message: "A file carries at most 12 tags." };
  return { ok: true, tags };
}

export async function listMedia(
  env: Env,
  project: SiteProject,
  query: { q?: string; tag?: string; trashed?: "only"; cursor?: string; limit?: number },
  fetcher?: typeof fetch,
): Promise<{ items: MediaView[]; nextCursor: MediaList["nextCursor"] }> {
  requireCan(project, "read");
  const list = await siteClient(env, project.site, fetcher).media.list(query);
  return { items: list.items.map((i) => view(project, env, i)), nextCursor: list.nextCursor };
}

/** One file with every place the site's reference check finds it. null when the site has no such file. */
export async function mediaDetail(env: Env, project: SiteProject, id: string, fetcher?: typeof fetch): Promise<(MediaDetail & { src: string }) | null> {
  requireCan(project, "read");
  try {
    const detail = await siteClient(env, project.site, fetcher).media.get(id);
    return { ...detail, src: view(project, env, detail).src };
  } catch (error) {
    if (error instanceof SiteApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export type UploadOutcome = { ok: true; item: MediaView } | { ok: false; message: string };

/**
 * Uploads one file to the site. Carrel checks the site's own limits first, so a file the site would
 * refuse is not sent at all; the site API checks them again, and the bytes, before the site's code.
 */
export async function uploadMedia(
  env: Env,
  project: SiteProject,
  actor: MediaActor,
  file: { name: string; type: string; size: number; bytes: () => Promise<ArrayBuffer> },
  alt: string,
  fetcher?: typeof fetch,
): Promise<UploadOutcome> {
  requireCan(project, "edit");
  const limits = await mediaLimits(env, project, fetcher);
  if (!limits) return { ok: false, message: "This site has no media library yet." };
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  if (!limits.types.includes(type)) {
    return { ok: false, message: `${file.name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.` };
  }
  if (file.size > limits.maxBytes) {
    return { ok: false, message: `${file.name} is ${megabytes(file.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.` };
  }
  if (file.size === 0) return { ok: false, message: `${file.name} is empty.` };
  const changeId = crypto.randomUUID();
  try {
    const item = await siteClient(env, project.site, fetcher).media.upload({
      bytes: new Uint8Array(await file.bytes()),
      contentType: type,
      filename: file.name.replace(/[/\\]/g, "-").slice(0, 200),
      alt: alt.trim().slice(0, 2000),
      changeId,
    });
    await record(env, project, actor, "media-upload", item.id, changeId);
    return { ok: true, item: view(project, env, item) };
  } catch (error) {
    if (error instanceof SiteApiError && error.body) return { ok: false, message: `The site refused ${file.name}: ${error.body.message}` };
    throw error;
  }
}

export type DeleteOutcome = { ok: true } | { ok: false; message: string; usedBy: MediaUse[] };

/** Asks the site to delete a file. The site's reference check decides; a file in use is refused, with every use named. */
export async function deleteMedia(env: Env, project: SiteProject, actor: MediaActor, id: string, fetcher?: typeof fetch): Promise<DeleteOutcome> {
  requireCan(project, "delete_media");
  const changeId = crypto.randomUUID();
  try {
    await siteClient(env, project.site, fetcher).media.delete(id, changeId);
    await record(env, project, actor, "media-delete", id, changeId);
    return { ok: true };
  } catch (error) {
    if (error instanceof SiteApiError && error.body) {
      return { ok: false, message: error.body.message, usedBy: error.body.usedBy ?? [] };
    }
    throw error;
  }
}

// ---------- the writes (site-api v0.4.0)

/** One write's outcome. `conflict` is a stale version (the file changed on the site since it was read). */
export type WriteOutcome = { ok: true; version: string; recorded: boolean } | { ok: false; conflict: boolean; message: string };

const CONFLICT = "This file changed on the site since you opened it. The page now shows what the site holds; make the change again if you still want it.";

/** A failed write said plainly: stale is a conflict, a 501 is "not offered", a refusal carries the site's own words. */
function writeFailure(error: unknown): WriteOutcome {
  if (error instanceof SiteApiError) {
    if (error.status === 409) return { ok: false, conflict: true, message: CONFLICT };
    if (error.status === 501) return { ok: false, conflict: false, message: "This site does not offer that." };
    if (error.status === 404) return { ok: false, conflict: false, message: "The site has no such file. It may have been deleted." };
    if (error.body) return { ok: false, conflict: false, message: `The site refused: ${error.body.message}` };
  }
  throw error;
}

async function writeOne(
  env: Env,
  project: SiteProject,
  actor: MediaActor,
  action: Exclude<MediaAction, "media-upload" | "media-delete">,
  id: string,
  expectedVersion: string,
  send: (changeId: string) => Promise<{ version: string }>,
): Promise<WriteOutcome> {
  requireCan(project, "edit");
  const changeId = crypto.randomUUID();
  let result: { version: string };
  try {
    result = await send(changeId);
  } catch (error) {
    return writeFailure(error);
  }
  // The site has done it; a record that cannot be written is reported, never allowed to hide that.
  let recorded = true;
  try {
    await record(env, project, actor, action, id, changeId, { before: expectedVersion, after: result.version });
  } catch (error) {
    recorded = false;
    console.error(JSON.stringify({ record: "failed", mediaId: id, action, changeId, error: String(error) }));
  }
  return { ok: true, version: result.version, recorded };
}

export function setMediaAlt(env: Env, project: SiteProject, actor: MediaActor, id: string, alt: string, expectedVersion: string, fetcher?: typeof fetch) {
  return writeOne(env, project, actor, "media-alt", id, expectedVersion, (changeId) =>
    siteClient(env, project.site, fetcher).media.setAlt(id, { alt: alt.trim().slice(0, 2000), expectedVersion, changeId }),
  );
}

export function setMediaTags(env: Env, project: SiteProject, actor: MediaActor, id: string, tags: string[], expectedVersion: string, fetcher?: typeof fetch) {
  return writeOne(env, project, actor, "media-tags", id, expectedVersion, (changeId) =>
    siteClient(env, project.site, fetcher).media.setTags(id, { tags, expectedVersion, changeId }),
  );
}

/** Moves a file to the site's trash. Reversible, so an Editor may; the site keeps the file until the trash is emptied. */
export function trashMedia(env: Env, project: SiteProject, actor: MediaActor, id: string, expectedVersion: string, fetcher?: typeof fetch) {
  return writeOne(env, project, actor, "media-trash", id, expectedVersion, (changeId) =>
    siteClient(env, project.site, fetcher).media.trash(id, { expectedVersion, changeId }),
  );
}

export function restoreMedia(env: Env, project: SiteProject, actor: MediaActor, id: string, expectedVersion: string, fetcher?: typeof fetch) {
  return writeOne(env, project, actor, "media-restore", id, expectedVersion, (changeId) =>
    siteClient(env, project.site, fetcher).media.restore(id, { expectedVersion, changeId }),
  );
}

export type BulkOp = MediaBulkInput["op"];
export const MAX_MEDIA_BULK = 100;

/** One file's outcome in a bulk action: this file was done, or left as it was and why. */
export type FileResult = { id: string; ok: boolean; message: string; usedBy?: MediaUse[] };

const ACTION_OF: Record<BulkOp, MediaAction> = {
  trash: "media-trash",
  restore: "media-restore",
  delete: "media-delete",
  "add-tags": "media-tags",
  "remove-tags": "media-tags",
};

const DONE_OF: Record<BulkOp, string> = {
  trash: "Moved to the trash.",
  restore: "Restored to the library.",
  delete: "Deleted from the site.",
  "add-tags": "Tags added.",
  "remove-tags": "Tags removed.",
};

/**
 * One action on several files, in one request to the site. The role is checked once before the site
 * hears anything (deleting is the Owner's, the rest an Editor's). The site answers file by file: a
 * stale version or a file a post uses refuses that file alone, and every file gets an outcome. Each
 * file the site carried out is its own row in the authorship record, under the change id sent for it.
 */
export async function bulkMedia(
  env: Env,
  project: SiteProject,
  actor: MediaActor,
  op: BulkOp,
  items: readonly { id: string; version?: string | null }[],
  tags: readonly string[] = [],
  fetcher?: typeof fetch,
): Promise<FileResult[]> {
  requireCan(project, op === "delete" ? "delete_media" : "edit");
  if (items.length === 0) throw new Response("Choose at least one file.", { status: 400 });
  if (items.length > MAX_MEDIA_BULK) throw new Response(`At most ${MAX_MEDIA_BULK} files at a time.`, { status: 400 });
  if ((op === "add-tags" || op === "remove-tags") && tags.length === 0) throw new Response("Name at least one tag.", { status: 400 });

  const unique = [...new Map(items.map((i) => [i.id, i])).values()];
  const results: FileResult[] = [];
  const sendable: { id: string; version: string | null; changeId: string }[] = [];
  for (const item of unique) {
    // A write needs the version the person saw; without one the site could not tell a stale write from a fresh one.
    if (op !== "delete" && !item.version) results.push({ id: item.id, ok: false, message: "Carrel does not know this file's version, so nothing was sent. Reload the page and try again." });
    else sendable.push({ id: item.id, version: item.version ?? null, changeId: crypto.randomUUID() });
  }
  if (sendable.length === 0) return results;

  let answer;
  try {
    answer = await siteClient(env, project.site, fetcher).media.bulk({
      op,
      ...(op === "add-tags" || op === "remove-tags" ? { tags: [...tags] } : {}),
      items: sendable.map((s) => ({ id: s.id, changeId: s.changeId, ...(op !== "delete" && s.version ? { expectedVersion: s.version } : {}) })),
    });
  } catch (error) {
    if (error instanceof SiteApiError && error.status === 501) throw new Response("This site does not offer that.", { status: 501 });
    throw error;
  }

  const sent = new Map(sendable.map((s) => [s.id, s]));
  for (const outcome of answer.results) {
    if (outcome.ok) {
      let message = DONE_OF[op];
      try {
        await record(env, project, actor, ACTION_OF[op], outcome.id, outcome.changeId, { before: sent.get(outcome.id)?.version ?? null, after: outcome.version ?? null });
      } catch (error) {
        console.error(JSON.stringify({ record: "failed", mediaId: outcome.id, action: ACTION_OF[op], changeId: outcome.changeId, error: String(error) }));
        message += " The authorship record for it could not be saved.";
      }
      results.push({ id: outcome.id, ok: true, message });
    } else {
      results.push({
        id: outcome.id,
        ok: false,
        message: outcome.error === "version-conflict" ? "This file changed on the site since you opened the library. It was left as it was." : outcome.message,
        ...(outcome.usedBy && outcome.usedBy.length > 0 ? { usedBy: outcome.usedBy } : {}),
      });
    }
  }
  return results;
}

/** The files in the trash, for the Trash view and the empty-trash confirm. `more` when the trash holds past one request's reach. */
export async function listTrash(env: Env, project: SiteProject, fetcher?: typeof fetch): Promise<{ items: MediaItem[]; more: boolean }> {
  requireCan(project, "read");
  const list = await siteClient(env, project.site, fetcher).media.list({ trashed: "only", limit: MAX_MEDIA_BULK + 1 });
  return { items: list.items.slice(0, MAX_MEDIA_BULK), more: list.items.length > MAX_MEDIA_BULK || list.nextCursor !== null };
}

export type EmptyOutcome = { deleted: string[]; refused: { id: string; message: string; usedBy: MediaUse[] }[]; more: boolean; unrecorded: number };

/**
 * Deletes for good every file in the trash (up to the site's limit per request), each through the
 * site's own reference check: a file a post still uses is refused and stays in the trash. The Owner's alone.
 * The site records file n under `<change id>-<n>` in the order it lists the trash, so Carrel lists the
 * same trash first to write the same ids into the authorship record.
 */
export async function emptyMediaTrash(env: Env, project: SiteProject, actor: MediaActor, fetcher?: typeof fetch): Promise<EmptyOutcome> {
  requireCan(project, "delete_media");
  const before = await listTrash(env, project, fetcher);
  const changeId = crypto.randomUUID();
  let answer;
  try {
    answer = await siteClient(env, project.site, fetcher).media.emptyTrash({ changeId });
  } catch (error) {
    if (error instanceof SiteApiError && error.status === 501) throw new Response("This site does not offer that.", { status: 501 });
    throw error;
  }
  let unrecorded = 0;
  for (const id of answer.deleted) {
    const n = before.items.findIndex((i) => i.id === id);
    const rowId = n >= 0 ? `${changeId}-${n + 1}` : `${changeId}:${id}`;
    try {
      await record(env, project, actor, "media-delete", id, rowId);
    } catch (error) {
      unrecorded += 1;
      console.error(JSON.stringify({ record: "failed", mediaId: id, action: "media-delete", changeId: rowId, error: String(error) }));
    }
  }
  return { deleted: answer.deleted, refused: answer.refused.map((r) => ({ ...r, usedBy: r.usedBy ?? [] })), more: answer.more, unrecorded };
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
