// The media library (stage 3), over the site API's media group (site-api v0.2.0). Files stay in the
// site's own storage and are served by the site: Carrel lists them, uploads to them and asks for
// deletes, and nothing about serving an image depends on Carrel. The site's reference check decides
// every delete; Carrel shows its answer.
//
// Roles, checked here so the page and any later tool meet the same rule: a Reader browses, an Editor
// also uploads (and inserts into a post), and only the Owner deletes.

import type { MediaDetail, MediaItem, MediaList, MediaUploadLimits, MediaUse } from "@dustinedwards/site-api";
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
async function record(env: Env, project: SiteProject, actor: MediaActor, action: "media-upload" | "media-delete", mediaId: string, changeId: string) {
  await drizzle(env.DB).insert(changes).values({
    id: changeId,
    projectId: project.id,
    itemId: mediaId,
    personId: actor.viewer.id,
    action,
    versionBefore: null,
    versionAfter: null,
    client: actor.client ?? null,
  });
}

function view(project: SiteProject, env: Env, item: MediaItem): MediaView {
  const connection = siteConnection(env, project.site);
  const origin = connection.state === "connected" ? connection.origin : "";
  return { ...item, src: origin ? absoluteMediaUrl(origin, item.url) : item.url };
}

/** What the site accepts, from its meta. null when the site offers no media (a v0.1.0 site). */
export async function mediaLimits(env: Env, project: SiteProject, fetcher?: typeof fetch): Promise<MediaUploadLimits | null> {
  requireCan(project, "read");
  const meta = await siteClient(env, project.site, fetcher).meta();
  return meta.capabilities.media ? (meta.capabilities.mediaUpload ?? null) : null;
}

export async function listMedia(
  env: Env,
  project: SiteProject,
  query: { q?: string; cursor?: string; limit?: number },
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

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
