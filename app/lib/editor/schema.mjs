// The formatted editor's schema: Tiptap's MIT StarterKit for prose, with what
// Markdown underneath needs. Every top-level block carries `md`, its origin (the bytes it was read
// from and the bytes before it), never rendered and never copied onto the half of a split block. A
// source block and a source atom hold Markdown the editor does not format, exactly as written.
// No DOM here: the browser adds the node views (components/editor/rich-editor.tsx), and the round-trip
// check builds the same schema in Node.
//
// Tracked changes (ruling point 9) are three marks, insertion, deletion and modification, with the
// shapes prosemirror-suggest-changes works on (MIT, Handle with Care Collective), plus who made the
// change (`by`, a person's id), its revision round and when. A whole block suggested in or out carries
// the mark on the block; Yjs does not carry marks on blocks, so the same mark also rides in the
// block's `smark` attribute (lib/editor/suggest.ts keeps the two in step). A save writes the text
// with every pending suggestion left out, so nothing suggested reaches a site or the repository.

import { Extension, getSchema, Mark, Node } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";

import { BLOCK_TYPES } from "./markdown.mjs";

const MdOrigin = Extension.create({
  name: "mdOrigin",
  addGlobalAttributes() {
    return [{ types: BLOCK_TYPES, attributes: { md: { default: null, rendered: false, keepOnSplit: false } } }];
  },
});

/** The block types a whole-block suggestion can sit on: every block the editor has. */
export const SUGGESTION_BLOCKS = [...BLOCK_TYPES, "listItem"];
const SUGGESTION_MARKS = "insertion modification deletion";

/**
 * A suggestion mark: one change by one person in one round, kept until someone accepts or rejects it.
 * @param {string} name
 * @param {string} tag
 * @param {Record<string, { default: unknown, rendered: false }>} extra
 */
function suggestionMark(name, tag, extra = {}) {
  return Mark.create({
    name,
    inclusive: false,
    excludes: name === "modification" ? "deletion insertion" : "insertion modification deletion",
    addAttributes() {
      return {
        id: { default: null, rendered: false },
        by: { default: null, rendered: false },
        round: { default: null, rendered: false },
        at: { default: null, rendered: false },
        ...extra,
      };
    },
    parseHTML() {
      return [{ tag: `${tag}[data-suggestion]` }];
    },
    renderHTML({ mark }) {
      return [tag, { "data-suggestion": name, "data-by": mark.attrs.by ?? "", "data-round": mark.attrs.round ?? "" }, 0];
    },
  });
}

export const Insertion = suggestionMark("insertion", "ins");
export const Deletion = suggestionMark("deletion", "del");
export const Modification = suggestionMark("modification", "span", {
  type: { default: null, rendered: false },
  attrName: { default: null, rendered: false },
  previousValue: { default: null, rendered: false },
  newValue: { default: null, rendered: false },
});

/** Blocks may carry a suggestion mark, and its copy in `smark` for Yjs; a split half never inherits either. */
const Suggestable = Extension.create({
  name: "suggestable",
  addGlobalAttributes() {
    return [{ types: SUGGESTION_BLOCKS, attributes: { smark: { default: null, rendered: false, keepOnSplit: false } } }];
  },
  extendNodeSchema(extension) {
    return ["doc", "bulletList", "orderedList", "listItem", "blockquote"].includes(extension.name) ? { marks: SUGGESTION_MARKS } : {};
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
    Insertion,
    Deletion,
    Modification,
    Suggestable,
  ];
}

/** The schema alone, for checking and normalizing JSON without an editor. */
export function editorSchema() {
  return getSchema(baseExtensions());
}
