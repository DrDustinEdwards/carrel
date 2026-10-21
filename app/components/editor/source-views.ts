// The formatted editor's views of Markdown it does not format (rich-editor.tsx): a source block edited
// as Markdown in a labelled textarea, and inline source shown as written.

import { SourceBlock, SourceInline } from "~/lib/editor/schema.mjs";

/** A source block in the formatted view: its kind, then its Markdown in a labelled textarea. */
export function sourceBlockView(readOnly: () => boolean) {
  return SourceBlock.extend({
    addNodeView() {
      return ({ node, getPos, editor }) => {
        let current = node;
        const dom = document.createElement("div");
        dom.className = "app-src-block";
        dom.contentEditable = "false";
        const label = document.createElement("span");
        label.className = "app-src-kind";
        label.setAttribute("aria-hidden", "true");
        const area = document.createElement("textarea");
        area.className = "app-src-text";
        area.spellcheck = false;
        const show = () => {
          label.textContent = `${current.attrs.kind}, Markdown`;
          area.setAttribute("aria-label", `${current.attrs.kind}, Markdown`);
          if (area.value !== current.attrs.text) area.value = current.attrs.text;
          area.rows = Math.max(1, area.value.split("\n").length);
          area.readOnly = readOnly();
        };
        show();
        area.addEventListener("input", () => {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pos === undefined) return;
          area.rows = Math.max(1, area.value.split("\n").length);
          editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, text: area.value }));
        });
        dom.appendChild(label);
        dom.appendChild(area);
        return {
          dom,
          update: (next) => {
            if (next.type !== current.type) return false;
            current = next;
            show();
            return true;
          },
          // Keys and clicks in the textarea are the textarea's own, not the editor's.
          stopEvent: (event) => event.target === area,
          ignoreMutation: () => true,
        };
      };
    },
  });
}

/** Markdown kept as written inside a paragraph: a directive, math, an image, a bare link. */
export const SourceInlineView = SourceInline.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("code");
      dom.className = "app-src-inline";
      dom.contentEditable = "false";
      dom.textContent = node.attrs.text;
      return { dom, ignoreMutation: () => true };
    };
  },
});
