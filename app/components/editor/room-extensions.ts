// What the formatted editor adds when it is in a file's room: the other people's carets and
// selections, suggesting (tracked changes, lib/editor/suggest.ts), and the comment threads marked in
// the text. The shared document itself is Tiptap's Collaboration extension over the room's Yjs copy.
//
// A caret's name is the room's word, never the other browser's: each caret is looked up by its Yjs
// client id in the room's list of people (who the door let in), and a caret the room does not list is
// not drawn.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, yCursorPlugin, yCursorPluginKey, ySyncPluginKey } from "@tiptap/y-tiptap";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { suggestingDispatch, suggestionPlugins, type Suggester } from "~/lib/editor/suggest";

/** A caret's person: their name and their color's slot (use-room.ts `personSlot`). */
export type Who = (clientId: number) => { name: string; slot: number } | null;

export function roomCarets(awareness: Awareness, who: () => Who) {
  return Extension.create({
    name: "carrelCarets",
    addProseMirrorPlugins() {
      return [
        yCursorPlugin(awareness, {
          awarenessStateFilter: (mine: number, theirs: number) => mine !== theirs && who()(theirs) !== null,
          cursorBuilder: (_user: unknown, clientId: number) => {
            const person = who()(clientId)!;
            const caret = document.createElement("span");
            caret.className = "app-caret";
            caret.dataset.who = String(person.slot);
            const label = document.createElement("span");
            label.className = "app-caret-name";
            label.textContent = person.name;
            // Word joiners either side keep the caret from breaking the line it sits in.
            caret.appendChild(document.createTextNode("\u2060"));
            caret.appendChild(label);
            caret.appendChild(document.createTextNode("\u2060"));
            return caret;
          },
          selectionBuilder: (_user: unknown, clientId: number) => ({ class: "app-caret-selection", "data-who": String(who()(clientId)?.slot ?? 0) }),
        }),
      ];
    },
  });
}

/** Draws the carets again, after the room's list of people changed. */
export function refreshCarets(state: EditorState) {
  return state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true });
}

/** Suggesting: each change this editor makes becomes a suggestion of the person's, while it is on. */
export function suggesting(suggester: Suggester) {
  const dispatch = suggestingDispatch(suggester);
  return Extension.create({
    name: "carrelSuggesting",
    addProseMirrorPlugins() {
      return suggestionPlugins();
    },
    dispatchTransaction({ transaction, next }) {
      next(dispatch(this.editor.state, transaction));
    },
  });
}

// ---- comments

export type Anchored = { id: string; anchor: string | null };
type Range = { from: Y.RelativePosition; to: Y.RelativePosition };

export const commentsKey = new PluginKey<DecorationSet>("carrel-comments");

/** Where a selection sits in the shared copy, so it stays put as people type around it. Null with no binding yet. */
export function anchorOf(state: EditorState, from: number, to: number): string | null {
  const y = ySyncPluginKey.getState(state);
  if (!y?.binding) return null;
  const at = (pos: number) => Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, y.type, y.binding.mapping));
  return JSON.stringify({ from: at(from), to: at(to) });
}

/** Where a thread's text is now, or null when that text is gone. */
export function rangeOf(state: EditorState, anchor: string | null): { from: number; to: number } | null {
  const y = ySyncPluginKey.getState(state);
  if (!anchor || !y?.binding) return null;
  try {
    const range = JSON.parse(anchor) as Range;
    const from = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(range.from), y.binding.mapping);
    const to = relativePositionToAbsolutePosition(y.doc, y.type, Y.createRelativePositionFromJSON(range.to), y.binding.mapping);
    return from !== null && to !== null && from < to ? { from, to } : null;
  } catch {
    return null;
  }
}

/** Marks each open thread's text; the one open in the panel is marked more strongly. */
export function commentMarks(get: () => { threads: Anchored[]; active: string | null }) {
  const build = (state: EditorState) => {
    const { threads, active } = get();
    const marks: Decoration[] = [];
    for (const t of threads) {
      const range = rangeOf(state, t.anchor);
      if (range) marks.push(Decoration.inline(range.from, range.to, { class: "app-comment-mark", "data-comment": t.id, ...(t.id === active ? { "data-active": "" } : {}) }));
    }
    return DecorationSet.create(state.doc, marks);
  };
  return Extension.create({
    name: "carrelComments",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: commentsKey,
          state: {
            init: (_config, state) => build(state),
            apply: (tr, old, _before, state) => (tr.docChanged || tr.getMeta(commentsKey) || tr.getMeta(ySyncPluginKey) ? build(state) : old.map(tr.mapping, tr.doc)),
          },
          props: {
            decorations: (state) => commentsKey.getState(state),
          },
        }),
      ];
    },
  });
}
