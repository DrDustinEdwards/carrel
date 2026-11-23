// In the Markdown editor: a block at the cursor on a line of its own, as the editor's own blocks are put.
// A .client module, so CodeMirror's view stays out of the Worker bundle.

import { EditorView } from "@codemirror/view";

export function insertIntoMarkdown(root: HTMLElement | null, text: string) {
  const dom = root?.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const prefix = line.from === from && line.text.trim() === "" ? "" : "\n\n";
  view.dispatch({
    changes: { from, to, insert: `${prefix}${text}` },
    selection: { anchor: from + prefix.length + text.length },
    scrollIntoView: true,
  });
  view.focus();
}
