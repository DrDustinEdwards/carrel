// The formatted editor's schema (job_1ba8094853f5): Tiptap's MIT StarterKit for prose, with what
// Markdown underneath needs. Every top-level block carries `md`, its origin (the bytes it was read
// from and the bytes before it), never rendered and never copied onto the half of a split block. A
// source block and a source atom hold Markdown the editor does not format, exactly as written.
// No DOM here: the browser adds the node views (components/editor/rich-editor.tsx), and the round-trip
// check builds the same schema in Node.

import { Extension, getSchema, Node } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";

import { BLOCK_TYPES } from "./markdown.mjs";

export const MdOrigin = Extension.create({
  name: "mdOrigin",
  addGlobalAttributes() {
    return [{ types: BLOCK_TYPES, attributes: { md: { default: null, rendered: false, keepOnSplit: false } } }];
  },
});

export const SourceBlock = Node.create({
  name: "sourceBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { text: { default: "", rendered: false }, kind: { default: "Markdown", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "pre[data-source-block]", getAttrs: (el) => ({ text: el.textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["pre", { "data-source-block": "" }, node.attrs.text];
  },
});

export const SourceInline = Node.create({
  name: "sourceInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { text: { default: "", rendered: false } };
  },
  parseHTML() {
    return [{ tag: "code[data-source-inline]", getAttrs: (el) => ({ text: el.textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["code", { "data-source-inline": "" }, node.attrs.text];
  },
});

/** Tab leaves the editor (WCAG 2.1.2), as it does today: the list item keeps Enter only. */
const ListItemNoTab = ListItem.extend({
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) };
  },
});

/** The extensions every editor and the round-trip check share. */
export function baseExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false,
      trailingNode: false,
      listItem: false,
      listKeymap: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: false, HTMLAttributes: { target: null, rel: null } },
    }),
    ListItemNoTab,
    MdOrigin,
    SourceBlock,
    SourceInline,
  ];
}

/** The schema alone, for checking and normalising JSON without an editor. */
export function editorSchema() {
  return getSchema(baseExtensions());
}
