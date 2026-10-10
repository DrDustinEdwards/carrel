// Markdown in and out of the formatted editor (job_1ba8094853f5, carrel/research/editor-spike.md).
// The source stays the truth. Parsing splits a file into its top-level blocks with the parser family
// the site renders with (micromark and mdast, as remark), and every block remembers its exact bytes
// and the bytes before it. Saving writes each block the editor did not change as those bytes, and
// only a changed or new block is spelled again, by the writer below, which is checked by parsing what
// it wrote. So a save changes the bytes of the blocks a person edited and no others.
//
// Prose (paragraphs, headings, lists, block quotes, breaks, and bold, italic, strikethrough, code and
// links inside them) becomes formatted text. Everything else becomes a source block, or inside a
// paragraph a source atom, that holds its Markdown as written: front matter, fenced and indented
// code, tables, directives, math, HTML, footnotes, images, references and bare links.
//
// Plain JavaScript with JSDoc types, so the app, the tests and scripts/check-roundtrip.mjs run the
// same code with no build step. It touches no DOM.

import { fromMarkdown } from "mdast-util-from-markdown";
import { directiveFromMarkdown } from "mdast-util-directive";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { directive } from "micromark-extension-directive";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/**
 * "site": a site's Markdown, with the directives and math dustinedwards.info renders.
 * "plain": a book file, which is CommonMark with GFM and a header.
 * @typedef {"site" | "plain"} Dialect
 * @typedef {{ id: number, source: string, before: string }} MdOrigin
 * @typedef {{ type: string, attrs?: Record<string, any>, content?: JsonNode[], text?: string, marks?: JsonMark[] }} JsonNode
 * @typedef {{ type: string, attrs?: Record<string, any> }} JsonMark
 * @typedef {{ doc: JsonNode, tail: string }} Loaded
 */

/** The node types that may hold a block's origin. */
export const BLOCK_TYPES = ["paragraph", "heading", "bulletList", "orderedList", "blockquote", "horizontalRule", "sourceBlock"];

/**
 * @param {string} source
 * @param {Dialect} dialect
 */
export function parseTree(source, dialect) {
  const site = dialect === "site";
  return fromMarkdown(source, {
    extensions: [frontmatter(["yaml"]), gfm(), ...(site ? [directive(), math()] : [])],
    mdastExtensions: [frontmatterFromMarkdown(["yaml"]), gfmFromMarkdown(), ...(site ? [directiveFromMarkdown(), mathFromMarkdown()] : [])],
  });
}

// ---------- reading: mdast to the editor's JSON

/** @param {any} node */
const span = (node) => [node.position.start.offset, node.position.end.offset];

/**
 * A node's bytes as written. A link GFM finds in bare text (www.example.com) is made after parsing
 * and has no position, so its bytes are its children's.
 * @param {any} node
 * @param {string} source
 * @returns {string}
 */
function sliceOf(node, source) {
  if (node.position?.start?.offset !== undefined && node.position?.end?.offset !== undefined) return source.slice(node.position.start.offset, node.position.end.offset);
  if (Array.isArray(node.children)) return node.children.map((/** @type {any} */ c) => sliceOf(c, source)).join("");
  return typeof node.value === "string" ? node.value : "";
}

/**
 * @param {any[]} children
 * @param {string} source
 * @param {JsonMark[]} marks
 * @returns {JsonNode[] | null} null when something here cannot be formatted text
 */
function inlines(children, source, marks = []) {
  /** @type {JsonNode[]} */
  const out = [];
  /** @param {JsonNode} n */
  const push = (n) => {
    const last = out.at(-1);
    // Adjacent text with the same marks is one text node, as ProseMirror keeps it.
    if (n.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) last.text = (last.text ?? "") + (n.text ?? "");
    else out.push(n);
  };
  /** @param {any} node */
  const atom = (node) => {
    push({ type: "sourceInline", attrs: { text: sliceOf(node, source) }, ...(marks.length ? { marks } : {}) });
  };
  for (const node of children) {
    switch (node.type) {
      case "text":
        if (node.value) push({ type: "text", text: node.value, ...(marks.length ? { marks } : {}) });
        break;
      case "emphasis":
      case "strong":
      case "delete": {
        const type = node.type === "emphasis" ? "italic" : node.type === "strong" ? "bold" : "strike";
        const inner = inlines(node.children, source, [...marks, { type }]);
        if (!inner || inner.length === 0) return null;
        inner.forEach(push);
        break;
      }
      case "inlineCode":
        // Code excludes every other mark in the editor, so code inside bold or a link stays as written.
        if (marks.length) atom(node);
        else push({ type: "text", text: node.value, marks: [{ type: "code" }] });
        break;
      case "link": {
        // Only [text](url) is formatted; a bare URL, <url> or an e-mail stays exactly as typed.
        if (!node.position || source[node.position.start.offset] !== "[" || node.children.length === 0 || marks.some((m) => m.type === "link")) {
          atom(node);
          break;
        }
        const inner = inlines(node.children, source, [...marks, { type: "link", attrs: { href: node.url, title: node.title ?? null } }]);
        if (!inner || inner.length === 0) atom(node);
        else inner.forEach(push);
        break;
      }
      case "break":
        push({ type: "hardBreak" });
        break;
      case "textDirective":
        // The site reads 4.5:1 and localhost:8080 as text, not as directives named "1" or "8080".
        if (/^\d/.test(node.name ?? "")) push({ type: "text", text: sliceOf(node, source), ...(marks.length ? { marks } : {}) });
        else atom(node);
        break;
      default:
        atom(node);
    }
  }
  return out;
}

/**
 * @param {any} node
 * @param {string} source
 * @returns {JsonNode | null} null when the block cannot be formatted text
 */
function blockJson(node, source) {
  switch (node.type) {
    case "paragraph": {
      const content = inlines(node.children, source);
      return content && content.length ? { type: "paragraph", content } : null;
    }
    case "heading": {
      const content = inlines(node.children, source);
      if (!content) return null;
      return { type: "heading", attrs: { level: node.depth }, ...(content.length ? { content } : {}) };
    }
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "blockquote": {
      const content = node.children.map((/** @type {any} */ c) => blockJson(c, source));
      if (content.length === 0 || content.some((/** @type {any} */ c) => !c)) return null;
      return { type: "blockquote", content };
    }
    case "list": {
      const items = [];
      for (const item of node.children) {
        // A task item has a checkbox the editor does not draw; it stays Markdown.
        if (item.checked !== null && item.checked !== undefined) return null;
        const content = item.children.map((/** @type {any} */ c) => blockJson(c, source));
        if (content.length === 0 || content[0]?.type !== "paragraph" || content.some((/** @type {any} */ c) => !c)) return null;
        items.push({ type: "listItem", content });
      }
      if (items.length === 0) return null;
      return node.ordered ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items } : { type: "bulletList", content: items };
    }
    default:
      return null;
  }
}

/** What a source block is, for its label: "Front matter", "Code", "Table", "Chart" and so on. */
/** @param {any} node */
function kindOf(node) {
  if (node.type === "yaml") return "Front matter";
  if (node.type === "code") return node.lang ? `Code (${node.lang})` : "Code";
  if (node.type === "table") return "Table";
  if (node.type === "math") return "Math";
  if (node.type === "html") return "HTML";
  if (node.type === "footnoteDefinition") return "Footnote";
  if (node.type === "definition") return "Link reference";
  if (node.type === "containerDirective" || node.type === "leafDirective") return node.name ? node.name.charAt(0).toUpperCase() + node.name.slice(1) : "Directive";
  if (node.type === "list") return "List";
  if (node.type === "blockquote") return "Quote";
  return "Markdown";
}

/**
 * A file as the editor's document: one top-level node per block, each with its origin.
 * @param {string} source
 * @param {Dialect} dialect
 * @returns {Loaded}
 */
export function toDoc(source, dialect) {
  const tree = parseTree(source, dialect);
  /** @type {JsonNode[]} */
  const content = [];
  let at = 0;
  tree.children.forEach((/** @type {any} */ node, /** @type {number} */ id) => {
    const [start, end] = span(node);
    const text = source.slice(start, end);
    const json = blockJson(node, source) ?? { type: "sourceBlock", attrs: { text, kind: kindOf(node) } };
    json.attrs = { ...json.attrs, md: { id, source: text, before: source.slice(at, start) } };
    content.push(json);
    at = end;
  });
  if (content.length === 0) {
    // An empty or blank file: one empty paragraph that writes nothing until something is typed.
    return { doc: { type: "doc", content: [{ type: "paragraph", attrs: { md: { id: 0, source: "", before: "" } } }] }, tail: source };
  }
  return { doc: { type: "doc", content }, tail: source.slice(at) };
}

// ---------- comparing

/**
 * A node with its origins taken out, as a string: two blocks with the same print are the same text.
 * @param {JsonNode} node
 */
export function print(node) {
  return JSON.stringify(node, (key, value) => (key === "md" ? undefined : value));
}

/**
 * The prints of a freshly loaded document's blocks, by origin id. Taken from the editor's own nodes
 * after loading, so whatever the editor's schema fills in is in both sides of the comparison.
 * @param {JsonNode} doc
 */
export function fingerprints(doc) {
  /** @type {Map<number, string>} */
  const prints = new Map();
  for (const block of doc.content ?? []) {
    const md = /** @type {MdOrigin | null | undefined} */ (block.attrs?.md);
    if (md) prints.set(md.id, print(block));
  }
  return prints;
}

/** The fields that carry meaning, so a check by parsing ignores the defaults the editor adds. */
/** @param {JsonNode} node @returns {any} */
function canon(node) {
  const keep = ["level", "start", "href", "title", "text"];
  /** @param {Record<string, any> | undefined} attrs */
  const attrs = (attrs) => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of keep) if (attrs && attrs[k] !== undefined && attrs[k] !== null && !(k === "start" && attrs[k] === 1)) out[k] = attrs[k];
    return out;
  };
  const order = ["link", "bold", "italic", "strike", "code"];
  /** @type {any[]} */
  const content = [];
  /** @param {any} c */
  const add = (c) => {
    if (c.type === "text" && c.text === "") return;
    const last = content.at(-1);
    if (c.type === "text" && last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(c.marks)) last.text += c.text;
    else content.push(c);
  };
  for (const child of node.content ?? []) {
    // A source atom is written as its bytes. Checked alone, a block can read it as plain text (a
    // reference whose definition is in another block), so both count as the same characters.
    const c = child.type === "sourceInline" ? canon({ type: "text", text: child.attrs?.text ?? "", marks: child.marks }) : canon(child);
    // Whitespace at the edge of bold or italic cannot be written inside the delimiters, so the writer
    // puts it outside; both readings count as the same text.
    if (c.type === "text" && c.marks.length && !c.marks.some((/** @type {any} */ m) => m.type === "code")) {
      const [, lead = "", body = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(c.text) ?? [];
      add({ ...c, text: lead, marks: [] });
      add({ ...c, text: body });
      add({ ...c, text: trail, marks: [] });
    } else add(c);
  }
  // Markdown trims the spaces at the start and end of a paragraph or heading.
  if ((node.type === "paragraph" || node.type === "heading") && content.length) {
    const first = content[0];
    const last = content.at(-1);
    if (first.type === "text") first.text = first.text.replace(/^[ \t]+/, "");
    if (last.type === "text") last.text = last.text.replace(/[ \t]+$/, "");
    while (content.length && content[0].type === "text" && content[0].text === "") content.shift();
    while (content.length && content.at(-1).type === "text" && content.at(-1).text === "") content.pop();
  }
  return {
    type: node.type,
    attrs: attrs(node.attrs),
    text: node.text,
    marks: (node.marks ?? []).map((m) => ({ type: m.type, attrs: attrs(m.attrs) })).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)),
    content,
  };
}

/**
 * Whether two blocks hold the same text and formatting, ignoring origins, the defaults the editor
 * fills in, and whitespace moved out of bold or italic.
 * @param {JsonNode} a
 * @param {JsonNode} b
 */
export function sameBlock(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// ---------- writing

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];

/**
 * @param {string} text
 * @param {{ all: boolean, dialect: Dialect, lineStart: boolean, afterAtom: boolean }} o
 * @returns {string}
 */
function escapeText(text, o) {
  // Right after a bare URL, a backslash would become part of the URL, so its first mark stays as is.
  const keep = o.afterAtom && /^[_*~]/.test(text) ? text[0] : "";
  if (keep) return keep + escapeText(text.slice(1), { ...o, afterAtom: false });
  if (o.all) return text.replace(/[!-/:-@[-`{-~]/g, (c) => `\\${c}`);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const prev = i === 0 ? "" : (text[i - 1] ?? "");
    const next = text[i + 1] ?? "";
    const word = (/** @type {string} */ ch) => /[\p{L}\p{N}]/u.test(ch);
    if (c === "\\" || c === "*" || c === "`") out += `\\${c}`;
    else if (c === "_" && !(word(prev) && word(next))) out += "\\_";
    else if (c === "~" && (next === "~" || prev === "~")) out += "\\~";
    else if (c === "<" && /[A-Za-z/!?]/.test(next)) out += "\\<";
    else if (c === "&" && /^&(#?[A-Za-z0-9]+);/.test(text.slice(i))) out += "\\&";
    else if (c === "[" && /\]\s*[([:]/.test(text.slice(i))) out += "\\[";
    else if (o.dialect === "site" && c === ":" && /[A-Za-z]/.test(next) && prev !== ":") out += "\\:";
    else if (o.dialect === "site" && c === "$") out += "\\$";
    else out += c;
  }
  // What would start another block at the start of a line.
  return out.replace(/(^|\n)([ \t]*)(#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t])|\d{1,9}(?=[.)][ \t]|[.)]$)|=+[ \t]*$|-+[ \t]*$)/g, (m, nl, ws, mark) => {
    if (!o.lineStart && nl === "") return m;
    return /^\d/.test(mark) ? `${nl}${ws}${mark}\\` : `${nl}${ws}\\${mark}`;
  });
}

/** @param {string} code */
function codeSpan(code) {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$|^ .* $/.test(code) || code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** @param {string} href @param {string | null} title */
function linkTail(href, title) {
  const url = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : href;
  return `](${url}${title ? ` "${title.replace(/["\\]/g, (c) => `\\${c}`)}"` : ""})`;
}

/**
 * @param {JsonNode[]} nodes
 * @param {{ all: boolean, dialect: Dialect, emphasis: string }} o
 */
function writeInlines(nodes, o) {
  /** @type {JsonMark[]} */
  let open = [];
  let out = "";
  /** @param {JsonMark} m @param {boolean} opening */
  const delim = (m, opening) => {
    if (m.type === "bold") return "**";
    if (m.type === "italic") return o.emphasis;
    if (m.type === "strike") return "~~";
    if (m.type === "link") return opening ? "[" : linkTail(m.attrs?.href ?? "", m.attrs?.title ?? null);
    return "";
  };
  const sorted = (/** @type {JsonNode} */ n) => [...(n.marks ?? [])].filter((m) => m.type !== "code").sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  const same = (/** @type {JsonMark} */ a, /** @type {JsonMark} */ b) => a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
  /** @param {JsonMark[]} wanted @param {string} lead */
  const moveTo = (wanted, lead = "") => {
    let keep = 0;
    while (keep < open.length && keep < wanted.length && same(/** @type {JsonMark} */ (open[keep]), /** @type {JsonMark} */ (wanted[keep]))) keep++;
    for (let i = open.length - 1; i >= keep; i--) out += delim(/** @type {JsonMark} */ (open[i]), false);
    out += lead;
    for (let i = keep; i < wanted.length; i++) out += delim(/** @type {JsonMark} */ (wanted[i]), true);
    open = wanted;
  };
  nodes.forEach((node, i) => {
    const marks = sorted(node);
    if (node.type === "text") {
      const code = (node.marks ?? []).some((m) => m.type === "code");
      let text = node.text ?? "";
      // Delimiters cannot sit against a space: whitespace at the edges of a marked run goes outside.
      const prefix = (/** @type {JsonMark[]} */ a, /** @type {JsonMark[]} */ b) => {
        let k = 0;
        while (k < a.length && k < b.length && same(/** @type {JsonMark} */ (a[k]), /** @type {JsonMark} */ (b[k]))) k++;
        return k;
      };
      // A mark opens or closes wherever the stack changes below it, not only where it starts or ends.
      const opens = prefix(open, marks) < marks.length;
      const lead = opens && !code ? (/^\s+/.exec(text)?.[0] ?? "") : "";
      text = text.slice(lead.length);
      const after = sorted(nodes[i + 1] ?? { type: "end" });
      const closes = prefix(marks, after) < marks.length;
      const trail = closes && !code ? (/\s+$/.exec(text)?.[0] ?? "") : "";
      text = text.slice(0, text.length - trail.length);
      moveTo(marks, lead);
      const lineStart = out === "" || out.endsWith("\n");
      out += code ? codeSpan(text) : escapeText(text, { all: o.all, dialect: o.dialect, lineStart, afterAtom: !lead && nodes[i - 1]?.type === "sourceInline" });
      if (trail) {
        moveTo(marks.slice(0, prefix(marks, after)));
        out += trail;
      }
    } else if (node.type === "hardBreak") {
      moveTo(marks);
      out += "\\\n";
    } else if (node.type === "sourceInline") {
      moveTo(marks);
      out += node.attrs?.text ?? "";
    }
  });
  moveTo([]);
  return out;
}

/** @param {string} text @param {string} first @param {string} rest */
const indent = (text, first, rest) =>
  text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line === "" ? "" : rest) + line)
    .join("\n");

/**
 * One block, spelled in the house style.
 * @param {JsonNode} node
 * @param {{ all: boolean, dialect: Dialect, emphasis: string }} o
 * @returns {string}
 */
function writeBlock(node, o) {
  switch (node.type) {
    case "paragraph":
      return writeInlines(node.content ?? [], o);
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 1)}${node.content?.length ? ` ${writeInlines(node.content, o)}` : ""}`;
    case "horizontalRule":
      return "***";
    case "sourceBlock":
      return node.attrs?.text ?? "";
    case "blockquote":
      return (node.content ?? [])
        .map((c) => writeBlock(c, o))
        .join("\n\n")
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    case "bulletList":
    case "orderedList": {
      const start = node.attrs?.start ?? 1;
      const items = node.content ?? [];
      const loose = items.some((item) => (item.content ?? []).filter((c) => c.type !== "bulletList" && c.type !== "orderedList").length > 1);
      return items
        .map((item, i) => {
          const marker = node.type === "bulletList" ? "- " : `${start + i}. `;
          const body = (item.content ?? []).map((c) => writeBlock(c, o)).join(loose ? "\n\n" : "\n");
          return indent(body, marker, " ".repeat(marker.length));
        })
        .join(loose ? "\n\n" : "\n");
    }
    default:
      return "";
  }
}

/** The emphasis delimiter a block already uses, so an edit keeps its spelling. */
/** @param {JsonNode} block */
function emphasisOf(block) {
  const source = /** @type {MdOrigin | null | undefined} */ (block.attrs?.md)?.source ?? "";
  return /(^|[^\p{L}\p{N}_])_[^_\s]/u.test(source) && !/(^|[^*\\])\*[^*\s]/.test(source) ? "_" : "*";
}

/**
 * A changed block, spelled and then checked: what was written must parse back to the same block.
 * When the light escaping does not survive, every punctuation mark in the text is escaped.
 * @param {JsonNode} block
 * @param {Dialect} dialect
 */
export function writeChecked(block, dialect) {
  if (block.type === "sourceBlock") return block.attrs?.text ?? "";
  const emphasis = emphasisOf(block);
  const want = JSON.stringify(canon(block));
  let text = "";
  for (const all of [false, true]) {
    text = writeBlock(block, { all, dialect, emphasis });
    if (block.type === "paragraph" && !(block.content ?? []).length) return "";
    const back = toDoc(text, dialect).doc.content ?? [];
    if (back.length === 1 && JSON.stringify(canon(/** @type {JsonNode} */ (back[0]))) === want) return text;
  }
  return text;
}

/**
 * The file the editor's document stands for. A block the editor did not change is written as the
 * bytes it was read from, with the bytes that came before it; a changed one keeps the bytes before
 * it and is spelled again; a new one follows a blank line.
 * @param {JsonNode} doc the editor's document as JSON
 * @param {string} tail what followed the last block when the file was read
 * @param {Map<number, string>} prints the blocks as they were loaded (fingerprints)
 * @param {Dialect} dialect
 */
export function fromDoc(doc, tail, prints, dialect) {
  let out = "";
  for (const block of doc.content ?? []) {
    const md = /** @type {MdOrigin | null | undefined} */ (block.attrs?.md);
    if (md && prints.get(md.id) === print(block)) {
      out += md.before + md.source;
      continue;
    }
    const text = writeChecked(block, dialect);
    if (md) out += md.before + text;
    else if (text !== "") out += (out === "" ? "" : "\n\n") + text;
  }
  return out + tail;
}

/**
 * Markdown pasted as plain text, as blocks with no origin: they are new, and are spelled on save.
 * @param {string} text
 * @param {Dialect} dialect
 * @returns {JsonNode[]}
 */
export function pastedBlocks(text, dialect) {
  return JSON.parse(JSON.stringify(toDoc(text, dialect).doc.content ?? []), (key, value) => (key === "md" ? null : value));
}
