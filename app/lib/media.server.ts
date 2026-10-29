// The media library (stage 3), over the site API's media group (site-api v0.2.0). Files stay in the
// site's own storage and are served by the site: Carrel lists them, uploads to them and asks for
// deletes, and nothing about serving an image depends on Carrel. The site's reference check decides
// every delete; Carrel shows its answer.
//
// Roles, checked here so the page and any later tool meet the same rule: a Reader browses, an Editor
// also uploads (and inserts into a post), edits alt text, caption, tags and the focal point, and moves
// files to the trash and back (all reversible), and only the Owner deletes for good, empties the trash
// or replaces a file's bytes (which changes every page that shows it, and cannot be taken back here).
//
// The writes (site-api v0.4.0) are each optional per site: the site's meta says which it offers
// (`mediaAlt`, `mediaTags`, `mediaTrash`), and the screens hide what it does not. A 501 means the same.
// The focal point, the caption and replacing a file are site-api v0.10.0 (`mediaFocus`, `mediaCaption`,
// `mediaReplace`), called through site-next.server.ts until the package's client carries them.

import type { MediaBulkInput, MediaDetail, MediaItem, MediaList, MediaUploadLimits, MediaUse } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can, type Action } from "~/lib/roles";
import { CROPPABLE, cropType } from "~/components/media/format";
import { focusValue, getMediaNext, listMediaNext, readMeta, replaceFile, setCaption, setFocus, type MediaNext } from "~/lib/site-next.server";
import { absoluteMediaUrl, siteClient, siteConnection } from "~/lib/sites.server";

function requireCan(project: SiteProject, action: Action) {
  if (!can(project.role, action)) throw new Response("Forbidden", { status: 403 });
}

/** A file as Carrel's screens show it: the site's item, plus the absolute address a browser loads. */
export type MediaView = MediaNext & { src: string };

/** Who did it: the person, and the AI client when it came through the AI door (credited in the record). */
export type MediaActor = { viewer: Viewer; client?: string };

/**
 * One row in the authorship record per media action that the site carried out (migration 0007): the
 * same change id Carrel sent the site, so the two histories join. A refused action writes nothing.
 */
type MediaAction = "media-upload" | "media-delete" | "media-alt" | "media-tags" | "media-trash" | "media-restore" | "media-focus" | "media-caption" | "media-replace";

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

function view<T extends MediaItem>(project: SiteProject, env: Env, item: T & Partial<Pick<MediaNext, "focus" | "caption">>): T & MediaView {
  const connection = siteConnection(env, project.site);
  const origin = connection.state === "connected" ? connection.origin : "";
  return { ...item, focus: item.focus ?? null, caption: item.caption ?? "", src: origin ? absoluteMediaUrl(origin, item.url) : item.url };
}

/** Which writes the site offers beyond upload and delete (site-api v0.4.0 and v0.10.0); a site lacking one never sees its screen. */
export type MediaOffers = { alt: boolean; tags: boolean; trash: boolean; focus: boolean; caption: boolean; replace: boolean };

export const NO_MEDIA_OFFERS: MediaOffers = { alt: false, tags: false, trash: false, focus: false, caption: false, replace: false };

/** What the site accepts and which writes it offers, from its meta. null when the site offers no media (a v0.1.0 site). */
export async function mediaMeta(env: Env, project: SiteProject, fetcher?: typeof fetch): Promise<{ limits: MediaUploadLimits; offers: MediaOffers } | null> {
  requireCan(project, "read");
  const { meta, extras } = await readMeta(env, project.site, fetcher);
  const { capabilities } = meta;
  if (!capabilities.media || !capabilities.mediaUpload) return null;
  return {
    limits: capabilities.mediaUpload,
    offers: {
      alt: capabilities.mediaAlt === true,
      tags: capabilities.mediaTags === true,
      trash: capabilities.mediaTrash === true,
      focus: extras.mediaFocus,
      caption: extras.mediaCaption,
      replace: extras.mediaReplace,
    },
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

/** A typed list of tags as a file's whole tag set: the content kit's, so Carrel and a site's own admin read tags alike. */
export { parseMediaTags } from "@dustinedwards/site-api/admin";

export async function listMedia(
  env: Env,
  project: SiteProject,
  query: { q?: string; tag?: string; trashed?: "only"; cursor?: string; limit?: number },
  fetcher?: typeof fetch,
): Promise<{ items: MediaView[]; nextCursor: MediaList["nextCursor"] }> {
  requireCan(project, "read");
  const list = await listMediaNext(env, project.site, query, fetcher);
  return { items: list.items.map((i) => view(project, env, i)), nextCursor: list.nextCursor };
}

/** One file with every place the site's reference check finds it. null when the site has no such file. */
export async function mediaDetail(env: Env, project: SiteProject, id: string, fetcher?: typeof fetch): Promise<(MediaDetail & MediaView) | null> {
  requireCan(project, "read");
  try {
    return view(project, env, await getMediaNext(env, project.site, id, fetcher));
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
  const limit = checkLimits(limits, file, type);
  if (limit) return { ok: false, message: limit };
  const changeId = crypto.randomUUID();
  try {
    const item = await siteClient(env, project.site, fetcher).media.upload({
      bytes: new Uint8Array(await file.bytes()),
      contentType: type,
      filename: cleanName(file.name),
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

/**
 * Sets the point of the picture its crops are cut around (site-api v0.10.0, `mediaFocus`): x and y each
 * from 0 to 1 from the top left, or null to clear it and leave the crop to the site's own guess.
 */
export function setMediaFocus(env: Env, project: SiteProject, actor: MediaActor, id: string, point: { x: number; y: number } | null, expectedVersion: string, fetcher?: typeof fetch) {
  const focus = point ? focusValue(point.x, point.y) : null;
  if (point && focus === null) return Promise.resolve<WriteOutcome>({ ok: false, conflict: false, message: "That is not a point on the picture." });
  return writeOne(env, project, actor, "media-focus", id, expectedVersion, (changeId) => setFocus(env, project.site, id, { focus, expectedVersion, changeId }, fetcher));
}

/** The caption a figure shows under the file, beside its alt text (site-api v0.10.0, `mediaCaption`). */
export function setMediaCaption(env: Env, project: SiteProject, actor: MediaActor, id: string, caption: string, expectedVersion: string, fetcher?: typeof fetch) {
  return writeOne(env, project, actor, "media-caption", id, expectedVersion, (changeId) =>
    setCaption(env, project.site, id, { caption: caption.trim().slice(0, 2000), expectedVersion, changeId }, fetcher),
  );
}

export type ReplaceOutcome = { ok: true; item: MediaView; recorded: boolean } | { ok: false; conflict: boolean; message: string };

/**
 * Replaces a file's bytes under the same id and address (site-api v0.10.0, `mediaReplace`): every post
 * that uses it shows the new one, and its alt text, caption and tags stay. The Owner's alone, like a
 * delete: it changes live pages, and the old bytes are gone from the site. The new file meets the
 * site's own limits first, as an upload does; a file of another type is refused, since the address
 * names the type.
 */
export async function replaceMedia(
  env: Env,
  project: SiteProject,
  actor: MediaActor,
  id: string,
  file: { name: string; type: string; size: number; bytes: () => Promise<ArrayBuffer> },
  expectedVersion: string,
  fetcher?: typeof fetch,
): Promise<ReplaceOutcome> {
  requireCan(project, "publish");
  const meta = await mediaMeta(env, project, fetcher);
  if (!meta?.offers.replace) return { ok: false, conflict: false, message: "This site does not replace files yet." };
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  const limit = checkLimits(meta.limits, file, type);
  if (limit) return { ok: false, conflict: false, message: limit };
  const current = await mediaDetail(env, project, id, fetcher);
  if (!current) return { ok: false, conflict: false, message: "The site has no such file. It may have been deleted." };
  if (current.contentType.split(";")[0]!.trim().toLowerCase() !== type) {
    return { ok: false, conflict: false, message: `${file.name} is ${type}, and this file is ${current.contentType}. A replacement keeps the file's address, so it must be the same type; upload it as a new file instead.` };
  }
  const changeId = crypto.randomUUID();
  let item: MediaNext;
  try {
    item = await replaceFile(env, project.site, id, { bytes: new Uint8Array(await file.bytes()), contentType: type, filename: cleanName(file.name), expectedVersion, changeId }, fetcher);
  } catch (error) {
    const failed = writeFailure(error);
    return failed.ok ? { ok: false, conflict: false, message: "The site did not replace the file." } : failed;
  }
  let recorded = true;
  try {
    await record(env, project, actor, "media-replace", id, changeId, { before: expectedVersion, after: item.version ?? null });
  } catch (error) {
    recorded = false;
    console.error(JSON.stringify({ record: "failed", mediaId: id, action: "media-replace", changeId, error: String(error) }));
  }
  return { ok: true, item: view(project, env, item), recorded };
}

/**
 * A file's bytes, read from where the site serves it, for the crop editor: through Carrel, so the
 * browser draws a same-origin image it may export. Only a file the site lists, and no larger than the
 * site's own upload limit.
 */
export async function mediaBytes(env: Env, project: SiteProject, id: string, fetcher?: typeof fetch): Promise<{ bytes: ArrayBuffer; type: string; name: string } | null> {
  const meta = await mediaMeta(env, project, fetcher);
  const detail = meta ? await mediaDetail(env, project, id, fetcher) : null;
  if (!meta || !detail || !CROPPABLE.includes(cropType(detail.contentType)) || detail.bytes > meta.limits.maxBytes) return null;
  const response = await (fetcher ?? fetch)(detail.src);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > meta.limits.maxBytes) return null;
  return { bytes, type: cropType(detail.contentType), name: detail.filename ?? detail.id.split("/").pop() ?? detail.id };
}

export type BulkOp = MediaBulkInput["op"];
const MAX_MEDIA_BULK = 100;

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

/** Why the site would refuse this file, or null when it meets the site's own limits. */
function checkLimits(limits: MediaUploadLimits, file: { name: string; size: number }, type: string): string | null {
  if (!limits.types.includes(type)) return `${file.name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`;
  if (file.size > limits.maxBytes) return `${file.name} is ${megabytes(file.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/** A file name as the site takes it: no path, at most 200 characters. */
function cleanName(name: string): string {
  return name.replace(/[/\\]/g, "-").slice(0, 200);
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
