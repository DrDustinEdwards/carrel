// The comment threads on a file (ruling build step 5), read for a page and by the file's room, which
// writes them (workers/doc-room.ts). A deleted comment is marked, never removed. And the names of the
// people who may be in a project's rooms, for the suggestions a page lists by person.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, people, projectMembers } from "~/db/schema";
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

/** Every person who may work in the project's rooms (its members and the Owner), by id. */
export async function roomNames(db: D1Database, projectId: number): Promise<Record<string, string>> {
  const rows = await drizzle(db)
    .selectDistinct({ id: people.id, name: people.name, email: people.email })
    .from(people)
    .leftJoin(projectMembers, and(eq(projectMembers.personId, people.id), eq(projectMembers.projectId, projectId)))
    .where(or(eq(people.isOwner, true), eq(projectMembers.projectId, projectId)))
    .all();
  return Object.fromEntries(rows.map((r) => [String(r.id), r.name || r.email]));
}
