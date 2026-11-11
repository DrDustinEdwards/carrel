// What a file's room and the editors in it say to each other, besides the document itself, which Yjs
// carries. The room is site-runtime's ./doc-room (workers/doc-room.ts gives it Carrel's roles, comments
// and backup copy); the editors' side is components/editor/use-room.ts.

import type { RoomViewer } from "@dustinedwards/site-runtime/doc-room";

import { can, type Role } from "~/lib/roles";

export type {
  ClientMessage,
  RoomComment,
  RoomPerson,
  RoomViewer,
  ServerMessage,
} from "@dustinedwards/site-runtime/doc-room";

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
