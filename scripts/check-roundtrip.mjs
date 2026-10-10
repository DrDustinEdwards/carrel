// check:roundtrip. Every Markdown file under the folders given must come back from the formatted
// editor byte for byte when it is opened and saved with no edit (job_1ba8094853f5). It runs the
// editor's own parser, schema and writer (app/lib/editor), with no browser: the document is loaded
// into the editor's schema and read back out of it, as the editor does.
//
// Then, for each file, each prose block in turn is edited (a word added at its end) and saved: every
// other block must keep its bytes, or the check fails. An edited block that does not parse back
// exactly as the editor holds it is listed as a warning: it changes nothing else.
//
// Run: npm run check:roundtrip -- <folder> [<folder> ...] [--plain]
//   --plain reads the files as a book's (no directives, no math); the default is a site's Markdown.
// Exit 0: every file and every edit held. Exit 1: a byte changed, listed with its file and line.
// Exit 2: no folder given, or no Markdown found in it.
//
// Writing is never committed to this repository: CI checks out the public dustinedwards-info
// content at test time, and private content is checked from a local clone.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { fingerprints, fromDoc, sameBlock, toDoc, writeChecked } from "../app/lib/editor/markdown.mjs";
import { editorSchema } from "../app/lib/editor/schema.mjs";

const args = process.argv.slice(2);
const dialect = args.includes("--plain") ? "plain" : "site";
const roots = args.filter((a) => !a.startsWith("--"));
if (roots.length === 0) {
  console.error("usage: npm run check:roundtrip -- <folder> [<folder> ...] [--plain]");
  process.exit(2);
}

/** @param {string} dir @returns {string[]} */
function markdownUnder(dir) {
  if (statSync(dir).isFile()) return dir.endsWith(".md") ? [dir] : [];
  return readdirSync(dir).flatMap((name) => (name === "node_modules" || name.startsWith(".") ? [] : markdownUnder(join(dir, name))));
}

const schema = editorSchema();
/** The document as the editor holds it: through the schema, so its defaults are filled in. */
const normalise = (/** @type {any} */ doc) => schema.nodeFromJSON(doc).toJSON();

/** @param {string} a @param {string} b */
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const line = a.slice(0, i).split("\n").length;
  const show = (/** @type {string} */ s) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 50));
  return `line ${line}: ${show(a)} became ${show(b)}`;
}

const files = roots.flatMap(markdownUnder);
if (files.length === 0) {
  console.error(`check:roundtrip: no Markdown under ${roots.join(", ")}`);
  process.exit(2);
}

/** @type {string[]} */
const problems = [];
/** Edited blocks that do not parse back exactly as the editor holds them: the edit's own block only. */
/** @type {string[]} */
const loose = [];
let edits = 0;
for (const file of files) {
  const name = relative(process.cwd(), file);
  const source = readFileSync(file, "utf8");
  let loaded;
  try {
    loaded = toDoc(source, dialect);
  } catch (error) {
    problems.push(`${name}: did not parse (${error instanceof Error ? error.message : error})`);
    continue;
  }
  const doc = normalise(loaded.doc);
  const prints = fingerprints(doc);
  const saved = fromDoc(doc, loaded.tail, prints, dialect);
  if (saved !== source) {
    problems.push(`${name}: a save with no edit changed it, ${firstDifference(source, saved)}`);
    continue;
  }

  // One edit at a time: a word at the end of each prose block. The rest must keep their bytes.
  doc.content.forEach((/** @type {any} */ block, /** @type {number} */ at) => {
    if (block.type === "sourceBlock" || block.type === "horizontalRule") return;
    const edited = JSON.parse(JSON.stringify(doc));
    // A word typed at the end of the block's last line of text, after whatever is there.
    /** @param {any} node @returns {boolean} */
    const addWord = (node) => {
      const kids = node.content ?? [];
      const last = kids.at(-1);
      if (node.type === "paragraph" || node.type === "heading") {
        kids.push({ type: "text", text: " edited" });
        node.content = kids;
        return true;
      }
      return last ? addWord(last) : false;
    };
    if (!addWord(edited.content[at])) return;
    edits++;
    const out = fromDoc(normalise(edited), loaded.tail, prints, dialect);
    const md = block.attrs.md;
    const written = writeChecked(normalise(edited).content[at], dialect);
    // The file with only that block's bytes replaced: anything else differing is a stray change.
    const start = doc.content.slice(0, at).reduce((/** @type {number} */ n, /** @type {any} */ b) => n + b.attrs.md.before.length + b.attrs.md.source.length, 0) + md.before.length;
    const expected = source.slice(0, start) + written + source.slice(start + md.source.length);
    if (out !== expected) problems.push(`${name}: an edit to block ${at + 1} changed other bytes, ${firstDifference(expected, out)}`);
    const back = toDoc(written, dialect).doc.content ?? [];
    if (back.length !== 1 || !sameBlock(normalise(edited).content[at], /** @type {any} */ (back[0]))) loose.push(`${name}: block ${at + 1}, once edited, reads back differently: ${JSON.stringify(written.slice(0, 160))}`);
  });
}

if (loose.length > 0) {
  console.warn(`check:roundtrip: ${loose.length} edited block${loose.length === 1 ? "" : "s"} of ${edits} read back differently (warning only: no other block changed)\n${loose.slice(0, 20).join("\n")}\n`);
}
if (problems.length > 0) {
  console.error(`check:roundtrip: ${problems.length} problem${problems.length === 1 ? "" : "s"} in ${files.length} files\n\n${problems.slice(0, 40).join("\n")}`);
  process.exit(1);
}
console.log(`check:roundtrip: ${files.length} files byte for byte after a save with no edit, and ${edits} single-block edits that changed only their own block (${dialect}).`);
