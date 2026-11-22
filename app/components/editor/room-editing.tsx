// A file's room in the post editor and the book file editor: Capsomer's collab editor, with this
// person's way of working in it (Editing or Suggesting, the revision round) remembered on this device,
// where Carrel keeps its other choices. Each page adds its own saving and publishing.

import { useRoomEditing as useCollabRoom, type RoomEditing } from "capsomer/react/collab-editor";
import { useRemembered } from "capsomer/react/hooks";

import type { RoomViewer } from "@dustinedwards/site-runtime/doc-room";

/** The page's loader data for the file: its room (null when none is started yet), its text and whether the room has unsaved changes. */
export function useRoomEditing(data: {
  room: { path: string; viewer: RoomViewer; names: Record<string, string> } | null;
  source: string;
  unsaved: boolean;
}): RoomEditing {
  const [mode, onMode] = useRemembered("carrel:write-mode");
  const [round, onRound] = useRemembered("carrel:suggest-round");
  return useCollabRoom({
    path: data.room?.path ?? "",
    initial: data.source,
    unsaved: data.unsaved,
    viewer: data.room?.viewer ?? { id: 0, name: "", access: "suggest" },
    names: data.room?.names ?? {},
    hideFrontMatter: true,
    mode: mode === "suggest" ? "suggest" : "edit",
    onMode,
    round: round ?? "",
    onRound,
  });
}
