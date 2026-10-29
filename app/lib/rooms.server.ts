// The browser door's side of live co-editing: opening a file's room for a page, the WebSocket into
// it, and saving from it. The room itself is workers/doc-room.ts.
//
// A page's loader opens the room before it renders: the first time anyone opens the file, the room
// starts from the opener's own earlier draft if they have one, else from what the site or Git holds.
// After that the room is the working copy for everyone, and the loader only reads it. When the site
// or Git moved on (a save through the AI door, another tool) and nobody has unsaved changes in the
// room, the room follows; with unsaved changes it stays, and the page says it is behind.
//
// A save takes the room's text at that moment, never the browser's: what everyone in the room sees is
// what is written. The version it is checked against is the room's too. After the write, the room is
// told the new version, and everyone who had a hand in the text goes into the authorship record.

import { getServerByName } from "partyserver";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changeContributors, changes, drafts, people, rooms } from "~/db/schema";
import { roomName } from "~/lib/editor/collab";
import type { Dialect } from "~/lib/editor/markdown.mjs";
import type { Viewer } from "~/lib/people.server";
import { can, type Role } from "~/lib/roles";
import { ROOM_VIEWER_HEADER, type RoomViewer } from "~/lib/editor/room-protocol";

type Where = { id: number; role: Role };

function stub(env: Env, projectId: number, itemId: string) {
  return getServerByName(env.DOC_ROOM, roomName(projectId, itemId));
}

export type OpenRoom = {
  /** The shared text now, as a save would write it. */
  source: string;
  /** The version the shared text started from: what a save is checked against. */
  version: string | null;
  /** Someone has changes in the room that are not saved to the site or Git. */
  unsaved: boolean;
  /** The site or Git holds a newer version than the room started from, and the room has unsaved changes. */
  behind: boolean;
  /** People connected now, before this page joins. */
  people: number;
  /** The opener's own draft from before the room, when the room had already started from something else. */
  ownDraft: { source: string; updatedAt: string } | null;
};

/**
 * The room for one file, ready for an editor to join. The first time, it starts from the opener's own
 * earlier draft, else `current`, what the site or Git holds now (null for a new file), else `starter`.
 * `unknown`: the site or Git did not answer, so a room not started yet is not started from nothing,
 * and the answer is null.
 */
export async function openRoom(
  env: Env,
  project: Where,
  viewer: Viewer,
  itemId: string,
  input: { dialect: Dialect; current: { source: string; version: string } | null; starter?: string; unknown?: boolean },
): Promise<OpenRoom | null> {
  const room = await stub(env, project.id, itemId);
  let status = await room.status();
  // Only someone who may edit brings a draft in; a Reader opens the file as it stands.
  const draft = can(project.role, "edit")
    ? await drizzle(env.DB)
        .select({ source: drafts.source, baseVersion: drafts.baseVersion, updatedAt: drafts.updatedAt })
        .from(drafts)
        .where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, itemId), eq(drafts.personId, viewer.id)))
        .get()
    : undefined;
  let ownDraft: OpenRoom["ownDraft"] = null;
  if (!status.seeded) {
    const own = draft ?? null;
    if (!own && input.unknown) return null;
    const start = own ? { markdown: own.source, version: own.baseVersion } : input.current ? { markdown: input.current.source, version: input.current.version } : { markdown: input.starter ?? "", version: null };
    // A draft, or a new file's template, is unsaved work: the room's last saved text is what the site or Git holds.
    await room.seed({ ...start, dialect: input.dialect, ...(own || !input.current ? { saved: input.current?.source ?? "" } : {}) });
    // The draft now lives in the room, where everyone sees it.
    if (own) await drizzle(env.DB).delete(drafts).where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, itemId), eq(drafts.personId, viewer.id)));
    status = await room.status();
  } else if (draft && draft.source !== status.markdown) {
    ownDraft = { source: draft.source, updatedAt: draft.updatedAt };
  }
  let unsaved = status.markdown !== status.meta.saved;
  const moved = input.current !== null && status.meta.version !== input.current.version;
  if (moved && !unsaved && input.current) {
    // Nothing would be lost: the room takes the newer version, unless someone just changed it.
    await room.replace({ markdown: input.current.source, version: input.current.version, by: "the site", expectedVersion: status.meta.version });
    status = await room.status();
    unsaved = status.markdown !== status.meta.saved;
  }
  return {
    source: status.markdown,
    version: status.meta.version,
    unsaved,
    behind: input.current !== null && status.meta.version !== input.current.version,
    people: status.people,
    ownDraft,
  };
}

/** Whether anyone has opened the file for live editing yet (its room keeps a copy in D1 from then on). */
export async function hasRoom(db: D1Database, projectId: number, itemId: string): Promise<boolean> {
  const row = await drizzle(db).select({ itemId: rooms.itemId }).from(rooms).where(and(eq(rooms.projectId, projectId), eq(rooms.itemId, itemId))).get();
  return Boolean(row);
}

/** Replaces the room's whole text for everyone. Takes edit: Discard, the site's version, an AI draft, a draft from before the room, an import. */
export async function replaceRoom(env: Env, project: Where, viewer: Viewer, itemId: string, input: { markdown: string; version: string | null; unsaved?: boolean }): Promise<void> {
  if (!can(project.role, "edit")) throw new Response("Forbidden", { status: 403 });
  const room = await stub(env, project.id, itemId);
  if (!(await room.replace({ ...input, by: viewer.name || viewer.email }))) throw new Response("Open the file before replacing its text.", { status: 409 });
}

/** The room's version now, for a write that sends no text (unpublish, unschedule). */
export async function roomVersion(env: Env, project: Where, itemId: string): Promise<string | null> {
  return (await (await stub(env, project.id, itemId)).snapshot()).version;
}

/** After a write that sent no text: the site's new version and text, for the room to take if nothing else changed. */
export async function rebaseRoom(env: Env, project: Where, itemId: string, now: { version: string; source: string }): Promise<void> {
  await (await stub(env, project.id, itemId)).rebase(now);
}

type Written = { ok: true; version: string; changeId: string } | { ok: false };

/**
 * Saves the room's text through `write`, which sends it with the room's version (site-api's
 * expectedVersion, or Git's sha) and says what happened; `others` is whether anyone besides the
 * person saving changed the text since the last save. On success the room takes the new version,
 * and every person who changed the text before it was taken is recorded beside the change.
 */
export async function saveRoom<T extends Written>(
  env: Env,
  project: Where,
  viewer: Viewer,
  itemId: string,
  write: (source: string, expectedVersion: string | null, others: boolean) => Promise<T>,
): Promise<T> {
  const room = await stub(env, project.id, itemId);
  const snap = await room.snapshot();
  // An empty room is not an empty file: nothing is written until the file has been opened.
  if (!snap.seeded) throw new Response("Open the file before saving it.", { status: 409 });
  const result = await write(snap.markdown, snap.version, snap.contributors.some((id) => id !== viewer.id));
  if (!result.ok) return result;
  const credited = await room.saved({ version: result.version, markdown: snap.markdown, snapshotAt: snap.at });
  const ids = [...new Set([viewer.id, ...credited])];
  await drizzle(env.DB)
    .insert(changeContributors)
    .values(ids.map((personId) => ({ changeId: result.changeId, personId })))
    .onConflictDoNothing();
  return result;
}

/**
 * Who had a hand in each save besides the person who pressed Save, by change id: the names the
 * history shows as "with ...".
 */
export async function coauthorsOf(db: D1Database, saves: { changeId: string; saver: number }[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (saves.length === 0) return out;
  const saver = new Map(saves.map((s) => [s.changeId, s.saver]));
  // D1 binds at most 100 values a statement.
  for (let i = 0; i < saves.length; i += 90) {
    const rows = await drizzle(db)
      .select({ changeId: changeContributors.changeId, id: people.id, name: people.name, email: people.email })
      .from(changeContributors)
      .innerJoin(people, eq(people.id, changeContributors.personId))
      .where(inArray(changeContributors.changeId, saves.slice(i, i + 90).map((s) => s.changeId)))
      .all();
    for (const r of rows) if (r.id !== saver.get(r.changeId)) out.set(r.changeId, [...(out.get(r.changeId) ?? []), r.name || r.email]);
  }
  return out;
}

/** A save's author with the others who wrote its text: "Dustin with Ana, Ben". */
export const withOthers = (author: string, others: string[] | undefined) => (others?.length ? `${author} with ${others.join(", ")}` : author);

/** The same for a post's revisions on its site, by the version each save made. */
export async function siteCoauthors(db: D1Database, projectId: number, itemId: string): Promise<Map<string, string[]>> {
  const saves = await drizzle(db)
    .select({ changeId: changes.id, saver: changes.personId, version: changes.versionAfter })
    .from(changes)
    .where(and(eq(changes.projectId, projectId), eq(changes.itemId, itemId)))
    .all();
  const others = await coauthorsOf(db, saves);
  return new Map(saves.flatMap((s) => (s.version && others.has(s.changeId) ? [[s.version, others.get(s.changeId)!] as const] : [])));
}

/** The path a page's editor connects to: /collab/p/<project>/<post> or /collab/b/<book>/<file path>. */
export function roomPath(kind: "p" | "b", slug: string, itemId: string): string {
  return `/collab/${kind}/${encodeURIComponent(slug)}/${itemId.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The WebSocket into a room, for the browser door: the person's role on the project decides what the
 * connection may do, and the room is told who they are in a header only this code sets.
 */
export async function connectRoom(request: Request, env: Env, viewer: Viewer, find: (kind: "p" | "b", slug: string) => Promise<Where>): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const match = /^\/collab\/(p|b)\/([^/]+)\/(.+)$/.exec(new URL(request.url).pathname);
  if (!match) return new Response("Not found", { status: 404 });
  const [, kind, slug, rest] = match as unknown as [string, "p" | "b", string, string];
  const itemId = rest.split("/").map(decodeURIComponent).join("/");
  const project = await find(kind, decodeURIComponent(slug));
  const access: RoomViewer["access"] | null = can(project.role, "edit") ? "edit" : can(project.role, "suggest") ? "suggest" : null;
  if (!access) return new Response("Forbidden", { status: 403 });
  const who: RoomViewer = { id: viewer.id, name: viewer.name || viewer.email, role: project.role, access };
  const headers = new Headers(request.headers);
  headers.set(ROOM_VIEWER_HEADER, JSON.stringify(who));
  const room = await stub(env, project.id, itemId);
  return room.fetch(new Request(request.url, { method: "GET", headers }));
}
