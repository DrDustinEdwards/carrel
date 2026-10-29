// What a file's room and the editors in it say to each other, besides the document itself, which Yjs
// carries. The room is workers/doc-room.ts; the editors' side is components/editor/use-room.ts.

/** Who a connection is: set by the browser door (rooms.server.ts), never by the browser. */
export type RoomViewer = { id: number; name: string; role: "reader" | "editor" | "author" | "owner"; access: "edit" | "suggest" };
export const ROOM_VIEWER_HEADER = "x-carrel-room-viewer";

/** One comment as everyone in the room sees it. */
export type RoomComment = {
  id: string;
  parentId: string | null;
  personId: number;
  name: string;
  body: string;
  /** Where a thread sits: Yjs relative positions of its start and end, as JSON. Null on a reply. */
  anchor: string | null;
  quote: string;
  createdAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
};

export type RoomPerson = { conn: string; id: number; name: string; access: RoomViewer["access"]; clients: number[] };

export type ServerMessage =
  | { t: "people"; people: RoomPerson[] }
  | { t: "comments"; comments: RoomComment[] }
  | { t: "flushed"; n: number }
  | { t: "refused"; reason: string }
  | { t: "replaced"; by: string }
  | { t: "error"; message: string };

export type ClientMessage =
  | { t: "flush"; n: number }
  | { t: "comment"; body: string; anchor: string | null; quote: string; parentId?: string | null }
  | { t: "comment-edit"; id: string; body: string }
  | { t: "comment-resolve"; id: string; resolved: boolean }
  | { t: "comment-delete"; id: string };
