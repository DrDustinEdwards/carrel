// The site API's next contract (v0.10.0), ahead of its client. Pinned site-api v0.9.0 has no
// scheduled update to a live post, no focal point, caption or replace for a file, and its client
// strips fields it does not know. The scheduled updates are site-api's own v0.10.0
// (DrDustinEdwards/site-api#59); the media fields are Carrel's proposal for the same release. So Carrel makes these calls itself, with the same key, prefix and
// error shape as the package's client, parses each answer with the package's own schemas, and reads
// the new fields beside them. A site that has not shipped a feature leaves its capability out of
// /meta, and Carrel then never offers it. Once site-api's client carries these, the calls move there
// and this file goes.
//
// The contract, as Carrel relies on it:
//
// - capabilities.scheduledUpdates (site-api#59): `POST /content/:id/schedule` on a published post
//   keeps it live with its text unchanged and holds the sent text as the one waiting update, which
//   the site publishes at publishAt; sent again, it reschedules. Summaries and docs carry
//   `scheduledUpdate: { publishAt, changeId } | null`. `GET /content/:id/schedule` answers the update
//   with its source (404 when none). `DELETE /content/:id/schedule?expectedVersion&changeId` cancels
//   it and the post stays live. A publish now, an unpublish or a delete drops it; a save to the live
//   post leaves it waiting, and its own text replaces the live one when it runs. Each moves the version.
// - capabilities.mediaFocus: a file's `focus` is "XxY", each 0 to 1 with up to three decimals, or
//   null; the site keeps it as the R2 object's customMetadata `focus` (FOCUS_METADATA), which
//   site-runtime's ./image reads for its crops, and refuses one `focusOf` would not take. `PUT /media/:id/focus` with `{ focus, expectedVersion, changeId }`.
// - capabilities.mediaCaption: a file's `caption` (up to 2,000 characters, "" for none).
//   `PUT /media/:id/caption` with `{ caption, expectedVersion, changeId }`.
// - capabilities.mediaReplace: `PUT /media/:id/file` with the new bytes as the body, their type as
//   Content-Type, and `filename`, `expectedVersion` and `changeId` as the query. The id and the
//   address stay, so every post that uses the file shows the new one; alt, caption and tags stay; the
//   focal point is cleared, since it named a place in the old picture. Answers the MediaItem with
//   `changeId` and `sizesNeedPurge`: true when the site's cache may still serve sizes made from the
//   old bytes until they are purged or their cache lifetime runs out, false when none can be stale.
//   Either way, a browser that already holds the old file keeps it until its own cache expires.
// Each media write answers a MediaWriteResult and moves the file's version, like alt and tags.

import { ContentDoc, ContentList, ErrorBody, MediaDetail, MediaItem, MediaList, MediaWriteResult, Meta, PREFIX, WriteResult } from "@dustinedwards/site-api";
import type { ContentSummary } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { focusOf } from "@dustinedwards/site-runtime/image";
import { z } from "zod";

import { siteConnection, SiteNotConnected, type SiteId } from "~/lib/sites.server";
import { timedFetch } from "~/lib/timed-fetch.server";

/** The v0.10.0 capabilities, each false on a site that does not name it. */
export type SiteExtras = { scheduledUpdates: boolean; mediaFocus: boolean; mediaCaption: boolean; mediaReplace: boolean };

const Extras = z.object({
  capabilities: z
    .object({
      scheduledUpdates: z.boolean().optional(),
      mediaFocus: z.boolean().optional(),
      mediaCaption: z.boolean().optional(),
      mediaReplace: z.boolean().optional(),
    })
    .loose(),
});

// v0.10.0's replace answer beyond the MediaItem. A site that leaves it out may still serve old sizes.
const ReplaceFields = z.object({ sizesNeedPurge: z.boolean() });

const MediaFields = z.object({
  focus: z.string().max(20).nullable().optional(),
  caption: z.string().max(2000).optional(),
});

const Waiting = z.object({ publishAt: z.iso.datetime({ offset: true }), changeId: z.string().min(1).max(200) });
const Scheduled = z.object({ scheduledUpdate: Waiting.nullable().optional() });
const ScheduledUpdate = Waiting.extend({ id: z.string(), source: z.string(), scheduledAt: z.iso.datetime({ offset: true }) });

/** The update waiting on a live post: when it goes live, and the change that scheduled it. */
type ScheduledUpdateSummary = z.infer<typeof Waiting>;
export type ScheduledUpdate = z.infer<typeof ScheduledUpdate>;
export type DocNext = ContentDoc & { scheduledUpdate: ScheduledUpdateSummary | null };
export type SummaryNext = ContentSummary & { scheduledUpdate: ScheduledUpdateSummary | null };
/** A file with the v0.10.0 fields: null and "" on a site that does not keep them. */
export type MediaNext<T extends MediaItem = MediaItem> = T & { focus: string | null; caption: string };

type Body = { json: unknown } | { bytes: Uint8Array<ArrayBuffer>; contentType: string };

function caller(env: Env, id: SiteId, fetcher?: typeof fetch) {
  const connection = siteConnection(env, id);
  if (connection.state !== "connected") throw new SiteNotConnected(connection.detail);
  const base = `${connection.origin}${PREFIX}`;
  const doFetch = fetcher ?? timedFetch;
  return async (method: string, path: string, body?: Body): Promise<unknown> => {
    const headers: Record<string, string> = { authorization: `Bearer ${connection.key}` };
    let payload: BodyInit | undefined;
    if (body && "json" in body) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body) {
      headers["content-type"] = body.contentType;
      payload = new Blob([body.bytes]);
    }
    const response = await doFetch(`${base}${path}`, { method, headers, body: payload });
    if (!response.ok) {
      let parsed = null;
      try {
        const result = ErrorBody.safeParse(await response.json());
        if (result.success) parsed = result.data;
      } catch {
        // Not JSON: the site's own error page.
      }
      throw new SiteApiError(response.status, parsed);
    }
    return response.json();
  };
}

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
  const text = search.toString();
  return text ? `?${text}` : "";
}

function media<T extends MediaItem>(item: T, raw: unknown): MediaNext<T> {
  const extra = MediaFields.safeParse(raw);
  // A focal point the site's own image route would not take (site-runtime ./image) is shown as none.
  return { ...item, focus: extra.success ? focusOf(extra.data.focus) : null, caption: extra.success ? (extra.data.caption ?? "") : "" };
}

/** The site's meta, with what it offers of v0.10.0. */
export async function readMeta(env: Env, id: SiteId, fetcher?: typeof fetch): Promise<{ meta: Meta; extras: SiteExtras }> {
  const raw = await caller(env, id, fetcher)("GET", "/meta");
  const meta = Meta.parse(raw);
  const extra = Extras.safeParse(raw);
  const c = extra.success ? extra.data.capabilities : {};
  return {
    meta,
    extras: { scheduledUpdates: c.scheduledUpdates === true, mediaFocus: c.mediaFocus === true, mediaCaption: c.mediaCaption === true, mediaReplace: c.mediaReplace === true },
  };
}

function scheduled(raw: unknown): ScheduledUpdateSummary | null {
  const extra = Scheduled.safeParse(raw);
  return extra.success ? (extra.data.scheduledUpdate ?? null) : null;
}

/** One post, with the update waiting to go live on it, if any. */
export async function getDoc(env: Env, id: SiteId, itemId: string, fetcher?: typeof fetch): Promise<DocNext> {
  const raw = await caller(env, id, fetcher)("GET", `/content/${enc(itemId)}`);
  return { ...ContentDoc.parse(raw), scheduledUpdate: scheduled(raw) };
}

/** One page of the site's list, each row with its waiting update, if any. */
export async function listContent(env: Env, id: SiteId, q: { limit: number; cursor?: string }, fetcher?: typeof fetch): Promise<{ items: SummaryNext[]; nextCursor: string | null }> {
  const raw = await caller(env, id, fetcher)("GET", `/content${query(q)}`);
  const list = ContentList.parse(raw);
  const rawItems = (raw as { items?: unknown[] }).items ?? [];
  return { items: list.items.map((item, i) => ({ ...item, scheduledUpdate: scheduled(rawItems[i]) })), nextCursor: list.nextCursor };
}

/** The update waiting on a live post, with its own text. null when none waits. */
export async function getScheduledUpdate(env: Env, id: SiteId, itemId: string, fetcher?: typeof fetch): Promise<ScheduledUpdate | null> {
  try {
    return ScheduledUpdate.parse(await caller(env, id, fetcher)("GET", `/content/${enc(itemId)}/schedule`));
  } catch (error) {
    if (error instanceof SiteApiError && (error.status === 404 || error.status === 501)) return null;
    throw error;
  }
}

/** Cancels the update waiting on a live post; the live post stays as it is. */
export async function cancelSchedule(env: Env, id: SiteId, itemId: string, input: { expectedVersion: string; changeId: string }, fetcher?: typeof fetch): Promise<WriteResult> {
  return WriteResult.parse(await caller(env, id, fetcher)("DELETE", `/content/${enc(itemId)}/schedule${query(input)}`));
}

export async function listMediaNext(
  env: Env,
  id: SiteId,
  q: { q?: string; tag?: string; trashed?: "only"; cursor?: string; limit?: number },
  fetcher?: typeof fetch,
): Promise<{ items: MediaNext[]; nextCursor: string | null }> {
  const raw = await caller(env, id, fetcher)("GET", `/media${query(q)}`);
  const list = MediaList.parse(raw);
  const rawItems = (raw as { items?: unknown[] }).items ?? [];
  return { items: list.items.map((item, i) => media(item, rawItems[i])), nextCursor: list.nextCursor };
}

export async function getMediaNext(env: Env, id: SiteId, mediaId: string, fetcher?: typeof fetch): Promise<MediaNext<MediaDetail>> {
  const raw = await caller(env, id, fetcher)("GET", `/media/${enc(mediaId)}`);
  return media(MediaDetail.parse(raw), raw);
}

export async function setFocus(env: Env, id: SiteId, mediaId: string, input: { focus: string | null; expectedVersion: string; changeId: string }, fetcher?: typeof fetch) {
  return MediaWriteResult.parse(await caller(env, id, fetcher)("PUT", `/media/${enc(mediaId)}/focus`, { json: input }));
}

export async function setCaption(env: Env, id: SiteId, mediaId: string, input: { caption: string; expectedVersion: string; changeId: string }, fetcher?: typeof fetch) {
  return MediaWriteResult.parse(await caller(env, id, fetcher)("PUT", `/media/${enc(mediaId)}/caption`, { json: input }));
}

export async function replaceFile(
  env: Env,
  id: SiteId,
  mediaId: string,
  input: { bytes: Uint8Array<ArrayBuffer>; contentType: string; filename: string; expectedVersion: string; changeId: string },
  fetcher?: typeof fetch,
): Promise<{ item: MediaNext; sizesNeedPurge: boolean }> {
  const raw = await caller(env, id, fetcher)(
    "PUT",
    `/media/${enc(mediaId)}/file${query({ filename: input.filename, expectedVersion: input.expectedVersion, changeId: input.changeId })}`,
    { bytes: input.bytes, contentType: input.contentType },
  );
  const extra = ReplaceFields.safeParse(raw);
  return { item: media(MediaItem.parse(raw), raw), sizesNeedPurge: extra.success ? extra.data.sizesNeedPurge : true };
}

/**
 * A focal point as the site stores it, from a point on the picture (each 0 to 1 from the top left),
 * clamped and rounded to three decimals, in the form site-runtime's ./image reads (`focusOf`). null
 * when either is not a number.
 */
export function focusValue(x: number, y: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const part = (n: number) => String(Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000);
  return focusOf(`${part(x)}x${part(y)}`);
}
