// Carrel's side of a file's room: who a connection is (Carrel's roles on Capsomer's viewer), who may
// enter, and the room's name. What the room and the editors say to each other is Capsomer's
// (capsomer/behavior/collab-editor); the room is workers/doc-room.ts.

import type { RoomViewer as SharedViewer } from "capsomer/behavior/collab-editor";

import { can, type Role } from "~/lib/roles";

/** Who a connection is: set by the browser door (rooms.server.ts), never by the browser. */
export type RoomViewer = SharedViewer & { role: "reader" | "editor" | "author" | "owner" };
export const ROOM_VIEWER_HEADER = "x-carrel-room-viewer";

/** What a role may do in a room: change the text, only suggest, or nothing (not let in). */
export function roomAccess(role: Role | null): RoomViewer["access"] | null {
  return can(role, "edit") ? "edit" : can(role, "suggest") ? "suggest" : null;
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
