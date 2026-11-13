// A file's room in the post editor and the book file editor: Capsomer's collab editor, with this
// person's way of working in it (Editing or Suggesting, the revision round) remembered on this device,
// where Carrel keeps its other choices. Each page adds its own saving and publishing.

import { useRoomEditing as useCollabRoom, type RoomEditing } from "capsomer/react/collab-editor";
import { useRemembered } from "capsomer/react/hooks";

import type { RoomViewer } from "@dustinedwards/site-runtime/doc-room";
import "capsomer/segmented.css";
import "capsomer/avatar.css";

export function useRoomEditing(options: {
  path: string;
  initial: string;
  /** The room had unsaved changes when the page was read. */
  unsaved: boolean;
  viewer: RoomViewer;
  names: Record<string, string>;
  hideFrontMatter: boolean;
}): RoomEditing {
  const [mode, onMode] = useRemembered("carrel:write-mode");
  const [round, onRound] = useRemembered("carrel:suggest-round");
  return useCollabRoom({
    ...options,
    mode: mode === "suggest" ? "suggest" : "edit",
    onMode,
    round: round ?? "",
    onRound,
  });
}
