// Carrel's way into Capsomer's collab editor: the room hook with this person's choices (Editing or
// Suggesting, the revision round) remembered on this device under Carrel's keys, and Carrel's roles
// read as what the panels may do. Each page adds its own saving and publishing.

import {
  useRoomEditing as useSharedRoomEditing,
  type RoomEditing,
} from "capsomer/react/collab-editor";

import type { RoomViewer } from "~/lib/editor/room-protocol";
import { useRemembered } from "~/lib/remembered";

const ROUND_KEY = "carrel:suggest-round";
const MODE_KEY = "carrel:write-mode";

export function useRoomEditing(options: {
  path: string;
  initial: string;
  /** The room had unsaved changes when the page was read. */
  unsaved: boolean;
  viewer: RoomViewer;
  names: Record<string, string>;
  hideFrontMatter: boolean;
}): RoomEditing {
  const [mode, rememberMode] = useRemembered(MODE_KEY);
  const [round, rememberRound] = useRemembered(ROUND_KEY);
  return useSharedRoomEditing({
    ...options,
    // The Owner deletes anyone's comment (the room's server checks the same).
    viewer: { ...options.viewer, deletesAny: options.viewer.role === "owner" },
    mode: mode === "suggest" ? "suggest" : "edit",
    onMode: rememberMode,
    round: round ?? "",
    onRound: rememberRound,
  });
}
