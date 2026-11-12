// What a file's room and the editors in it say to each other, besides the document itself, which Yjs
// carries, and Carrel's part of it: who a role lets in and the room's name for a file. The room is
// site-runtime's ./doc-room (workers/doc-room.ts gives it Carrel's roles, comments and backup copy);
// the editors' side is Capsomer's collab editor (components/editor/room-editing.tsx).

import type { RoomViewer } from "@dustinedwards/site-runtime/doc-room";

import { can, type Role } from "~/lib/roles";

/** What a role may do in a room: change the text, only suggest, or nothing (not let in). */
function roomAccess(role: Role | null): RoomViewer["access"] | null {
  return can(role, "edit") ? "edit" : can(role, "suggest") ? "suggest" : null;
}

/** Who a person is in a room with this role, or null when the role does not let them in. Only the Owner deletes anyone's comment. */
export function roomViewer(
  person: { id: number; name: string },
  role: Role | null,
): RoomViewer | null {
  const access = roomAccess(role);
  if (!access) return null;
  return {
    id: person.id,
    name: person.name,
    access,
    ...(role === "owner" ? { deletesAny: true } : {}),
  };
}

/** The name of the room for one file: its project and the item's id (a post's id, or a book file's path). */
export function roomName(projectId: number, itemId: string): string {
  return `${projectId}/${itemId}`;
}

export function parseRoomName(name: string): { projectId: number; itemId: string } | null {
  const at = name.indexOf("/");
  const projectId = Number(name.slice(0, at));
  return at > 0 && Number.isInteger(projectId) ? { projectId, itemId: name.slice(at + 1) } : null;
}
