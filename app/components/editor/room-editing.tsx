// What the post editor and the book file editor share in a file's room: the room itself, this
// person's way of working in it (Editing or Suggesting, the revision round), the editor once it is
// made, and the bar and panels around the text. Each page adds its own saving and publishing.

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listSuggestions } from "~/lib/editor/suggest";
import type { RoomViewer } from "~/lib/editor/room-protocol";

import { CommentsPanel } from "./comments-panel";
import type { RichRoom } from "./rich-editor";
import { RoomBar, type WriteMode } from "./room-bar";
import { SuggestionsPanel } from "./suggestions-panel";
import { personSlot, useRoom, type Room } from "./use-room";

const ROUND_KEY = "carrel:suggest-round";
const MODE_KEY = "carrel:write-mode";

export type RoomEditing = {
  room: Room;
  /** What the formatted editor needs, once the room's copy has arrived; null before. */
  rich: (RichRoom & { key: string }) | null;
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
  /** Suggestions waiting in the text. */
  pending: number;
  /** Why the Markdown view only shows the text, or null when it edits it. */
  markdownLocked: string | null;
  bar: React.ReactNode;
  panels: React.ReactNode;
};

export function useRoomEditing({
  path,
  initial,
  unsaved,
  viewer,
  names,
  hideFrontMatter,
}: {
  path: string;
  initial: string;
  /** The room had unsaved changes when the page was read. */
  unsaved: boolean;
  viewer: RoomViewer;
  names: Record<string, string>;
  hideFrontMatter: boolean;
}): RoomEditing {
  const room = useRoom(path, initial, unsaved);
  const mayEdit = viewer.access === "edit";
  const [mode, setMode] = useState<WriteMode>(mayEdit ? "edit" : "suggest");
  const [round, setRound] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // Remembered on this device: whether an editor was suggesting, and the round they were in.
  useEffect(() => {
    try {
      if (mayEdit && localStorage.getItem(MODE_KEY) === "suggest") setMode("suggest");
      setRound(localStorage.getItem(ROUND_KEY) ?? "");
    } catch {
      // Storage refused: the defaults.
    }
  }, [mayEdit]);
  const chooseMode = useCallback((next: WriteMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Not remembered, still switched.
    }
  }, []);
  const chooseRound = useCallback((next: string) => {
    setRound(next);
    try {
      localStorage.setItem(ROUND_KEY, next);
    } catch {
      // Not remembered.
    }
  }, []);

  useEffect(() => {
    if (!editor) return;
    const read = () => setPending(listSuggestions(editor.state.doc).length);
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);

  // The room's own word on whose each caret is: its Yjs client ids, by connection.
  const byClient = useMemo(() => {
    const map = new Map<number, { name: string; slot: number }>();
    for (const p of room.people) for (const c of p.clients) map.set(c, { name: p.name, slot: personSlot(p.id) });
    return map;
  }, [room.people]);
  const peopleKey = room.people.map((p) => `${p.conn}:${p.clients.join(".")}`).join(",");
  const threads = useMemo(() => room.comments.filter((c) => !c.parentId && !c.resolvedAt).map((c) => ({ id: c.id, anchor: c.anchor })), [room.comments]);

  const suggest = !mayEdit || mode === "suggest";
  const rich: RoomEditing["rich"] =
    room.synced && room.doc
      ? {
          key: `${path}#${room.generation}`,
          doc: room.doc,
          awareness: room.provider.awareness,
          who: (clientId) => byClient.get(clientId) ?? null,
          peopleKey,
          suggester: { by: String(viewer.id), clientId: room.doc.clientID, round: () => (localStorageRound() ?? round) || null },
          suggest,
          threads,
          activeThread: active,
          onThreadClick: setActive,
          hideFrontMatter,
        }
      : null;

  const markdownLocked = suggest
    ? "Suggestions are made in the formatted view. The Markdown here shows the text as it stands."
    : pending > 0
      ? "Accept or reject the suggestions first: Markdown cannot show them. The Markdown here shows the text without them."
      : null;

  const bar = <RoomBar people={room.people} me={viewer.id} status={room.status} mayEdit={mayEdit} mode={mode} onMode={chooseMode} pending={pending} />;
  const panels = (
    <>
      <SuggestionsPanel editor={editor} names={names} me={viewer.id} mayDecide={mayEdit} round={round} onRound={chooseRound} />
      <CommentsPanel comments={room.comments} me={viewer} send={room.send} editor={editor} active={active} onActive={setActive} />
    </>
  );
  return { room, rich, editor, setEditor, pending, markdownLocked, bar, panels };
}

/** The round as last chosen, read when a suggestion is made rather than when the editor was. */
function localStorageRound(): string | null {
  try {
    return localStorage.getItem(ROUND_KEY);
  } catch {
    return null;
  }
}
