// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/components/admin/md-editor-commands.ts).
// Unchanged.

import type { EditorView } from "@codemirror/view";

// The markdown editor's edit commands and block scaffolds. Imported only by the markdown editor and
// its toolbar, so they ride in the CodeMirror chunk and never reach a public bundle.

export function wrap(view: EditorView, before: string, after = before) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: selected
      ? { anchor: from + before.length, head: from + before.length + selected.length }
      : { anchor: from + before.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertBlock(view: EditorView, text: string, cursorOffset?: number) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const atLineStart = line.from === from && line.text.trim() === "";
  const prefix = atLineStart ? "" : "\n\n";
  const insert = `${prefix}${text}`;
  view.dispatch({
    changes: { from, to: view.state.selection.main.to, insert },
    selection: {
      anchor: from + prefix.length + (cursorOffset ?? text.length),
    },
    scrollIntoView: true,
  });
  view.focus();
}

export function cycleHeading(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const match = /^(#{2,4})\s+/.exec(line.text);
  const hashes = match?.[1] ?? "";
  const next = !hashes ? "## " : hashes.length >= 4 ? "" : `${"#".repeat(hashes.length + 1)} `;
  const strippedFrom = match ? match[0].length : 0;
  view.dispatch({
    changes: { from: line.from, to: line.from + strippedFrom, insert: next },
    scrollIntoView: true,
  });
  view.focus();
}

export function insertFootnote(view: EditorView) {
  const doc = view.state.doc;
  const existing = doc.toString().match(/\[\^(\d+)\]/g) ?? [];
  const n = existing.length + 1;
  const { from } = view.state.selection.main;
  const tail = doc.length;
  view.dispatch({
    changes: [
      { from, to: view.state.selection.main.to, insert: `[^${n}]` },
      { from: tail, insert: `\n\n[^${n}]: ` },
    ],
    // Land in the definition, the part that still needs writing.
    selection: { anchor: tail + `[^${n}]`.length + `\n\n[^${n}]: `.length },
    scrollIntoView: true,
  });
  view.focus();
}

// Alt is mandatory on :::chart and :::diagram and the build fails without it, so the cursor lands inside alt="".
export const SCAFFOLDS = {
  chart: {
    label: "Chart",
    hint: "Bar, line, dot or area from inline CSV",
    text: [
      ':::chart{type=bar x=name y=value title="" alt=""}',
      "```csv",
      "name,value",
      "first,1",
      "```",
      "An optional caption.",
      ":::",
    ].join("\n"),
    cursor: ':::chart{type=bar x=name y=value title="" alt="'.length,
  },
  diagram: {
    label: "Diagram",
    hint: "Mermaid, rendered by build:diagrams",
    text: [
      ':::diagram{title="" alt=""}',
      "```mermaid",
      "flowchart LR",
      "  A[Start] --> B[End]",
      "```",
      "An optional caption.",
      ":::",
    ].join("\n"),
    cursor: ':::diagram{title="" alt="'.length,
  },
  figure: {
    label: "Figure",
    hint: "An image with a caption",
    text: [':::figure{src="" alt=""}', "A caption.", ":::"].join("\n"),
    cursor: ':::figure{src="'.length,
  },
} as const;

export type ScaffoldName = keyof typeof SCAFFOLDS;
