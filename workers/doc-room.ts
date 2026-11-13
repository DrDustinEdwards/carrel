// The room for one file: site-runtime's ./doc-room (the shared copy on y-partyserver, the suggest gate,
// presence, the access recheck and the comment rules), given Carrel's parts: the document model, a
// person's role on the project from D1, the comment threads in D1 `comments`, and the Markdown mirrored
// into D1 `rooms`, which the nightly backup carries (ruling point 3, build step 10).
//
// Nobody reaches it but the browser door (workers/app.ts, behind Access): lib/rooms.server.ts checks the
// person's role and forwards the WebSocket with `viewerRequest`. A save is the editor route's
// (rooms.server.ts `saveRoom`): Git and the sites stay the store.

import { DocRoom as Room, type CommentStore } from "@dustinedwards/site-runtime/doc-room";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type * as Y from "yjs";

import { comments, rooms } from "~/db/schema";
import { listComments } from "~/lib/comments.server";
import {
  META,
  isSeeded,
  loadMarkdown,
  markSaved,
  readMeta,
  roomJson,
  roomMarkdown,
  roomSchema,
  settle,
  suggestionCounts,
  type JsonDoc,
} from "capsomer/behavior/collab-editor";
import { parseRoomName, roomViewer } from "~/lib/editor/room-protocol";
import { currentRole } from "~/lib/people.server";

export { ROLE_RECHECK_MS } from "@dustinedwards/site-runtime/doc-room";

const model = {
  // The Y.Map Capsomer's collab-editor-doc keeps the room's own state in (version, saved text, prints).
  metaKey: META,
  isSeeded,
  readMeta,
  markSaved,
  markdown: roomMarkdown,
  // The door's seed carries the dialect the text is read in.
  load: (doc: Y.Doc, input: Record<string, unknown>) =>
    loadMarkdown(doc, input as Parameters<typeof loadMarkdown>[1]),
  json: roomJson,
  settle: (json: unknown) => settle(roomSchema(), json as JsonDoc),
  suggestionCounts: (json: unknown) => suggestionCounts(roomSchema(), json as JsonDoc),
};

export class DocRoom extends Room<Env> {
  #where(): { projectId: number; itemId: string } {
    const where = parseRoomName(this.name);
    if (!where) throw new Error(`not a room name: ${this.name}`);
    return where;
  }

  override get model() {
    return model;
  }

  /** The role the person holds on the project now, read from D1. */
  override async access(viewer: { id: number; name: string }) {
    const role = await currentRole(this.env.DB, this.env, viewer.id, this.#where().projectId);
    return roomViewer(viewer, role);
  }

  /** The Markdown and the version into D1, so the nightly backup holds every room. */
  override async mirror(state: { markdown: string; version: string | null; saved: string }) {
    const { projectId, itemId } = this.#where();
    const now = new Date().toISOString();
    const row = {
      source: state.markdown,
      baseVersion: state.version,
      savedSource: state.saved,
      updatedAt: now,
    };
    await drizzle(this.env.DB)
      .insert(rooms)
      .values({ projectId, itemId, ...row })
      .onConflictDoUpdate({ target: [rooms.projectId, rooms.itemId], set: row });
  }

  /** The file's threads in D1 `comments`. A deleted comment is marked, never removed. */
  override get comments(): CommentStore {
    const { projectId, itemId } = this.#where();
    const db = drizzle(this.env.DB);
    const here = (id: string) =>
      and(eq(comments.id, id), eq(comments.projectId, projectId), eq(comments.itemId, itemId));
    return {
      list: () => listComments(this.env.DB, projectId, itemId),
      find: async (id) =>
        (await db
          .select({ personId: comments.personId, parentId: comments.parentId })
          .from(comments)
          .where(and(here(id), isNull(comments.deletedAt)))
          .get()) ?? null,
      add: async (c) => {
        await db.insert(comments).values({ ...c, projectId, itemId });
      },
      edit: async (id, body, at) => {
        await db.update(comments).set({ body, editedAt: at }).where(here(id));
      },
      resolve: async (id, by, at) => {
        await db
          .update(comments)
          .set(
            by === null
              ? { resolvedAt: null, resolvedBy: null }
              : { resolvedAt: at, resolvedBy: by },
          )
          .where(here(id));
      },
      remove: async (id, withReplies, at) => {
        await db.update(comments).set({ deletedAt: at }).where(here(id));
        if (withReplies)
          await db
            .update(comments)
            .set({ deletedAt: at })
            .where(
              and(
                eq(comments.parentId, id),
                eq(comments.projectId, projectId),
                eq(comments.itemId, itemId),
                isNull(comments.deletedAt),
              ),
            );
      },
    };
  }
}
