// The comment threads on a file (ruling build step 5), read for a page and by the file's room, which
// writes them (workers/doc-room.ts). A deleted comment is marked, never removed.

import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, people } from "~/db/schema";
import type { RoomComment } from "~/lib/editor/room-protocol";

export async function listComments(db: D1Database, projectId: number, itemId: string): Promise<RoomComment[]> {
  const rows = await drizzle(db)
    .select({
      id: comments.id,
      parentId: comments.parentId,
      personId: comments.personId,
      name: people.name,
      email: people.email,
      body: comments.body,
      anchor: comments.anchor,
      quote: comments.quote,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
      resolvedAt: comments.resolvedAt,
    })
    .from(comments)
    .innerJoin(people, eq(people.id, comments.personId))
    .where(and(eq(comments.projectId, projectId), eq(comments.itemId, itemId), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt))
    .all();
  return rows.map(({ email, ...r }) => ({ ...r, name: r.name || email }));
}
