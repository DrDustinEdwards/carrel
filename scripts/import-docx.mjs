// Imports a manuscript from Word files into a book folder in a clone of the novels repository, once,
// for review as a pull request. Nothing is sent anywhere: it reads the .docx files and writes Markdown.
//
//   npm run import:docx -- <file.docx | folder> [more...] --book <folder> --novels <path to novels clone> [--title "Title"]
//
// A folder's .docx files are read in name order (so name them 01-..., 02-...). In each file a
// Heading 1 starts a chapter; a file with none is one chapter named after the file. A paragraph that
// is only a scene-break mark (* * *, ***, #) starts a new scene. It refuses to write into a book that
// already has chapters, and writes the report of everything it flagged to <book>/build/.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { readDocx } from "./lib/docx.mjs";
import { buildBook, writeBook } from "./lib/manuscript.mjs";

const USAGE = 'usage: npm run import:docx -- <file.docx | folder> [more...] --book <folder> --novels <path to novels clone> [--title "Title"]';

/** @param {string} message */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
/** @type {Record<string, string>} */
const options = {};
/** @type {string[]} */
const inputs = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--book" || arg === "--novels" || arg === "--title") {
    const value = args[++i];
    if (value === undefined) fail(`${arg} needs a value.\n${USAGE}`);
    options[arg.slice(2)] = value;
  } else if (arg.startsWith("--")) {
    fail(`Unknown option ${arg}.\n${USAGE}`);
  } else {
    inputs.push(arg);
  }
}
if (inputs.length === 0 || !options.book || !options.novels) fail(USAGE);
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.book) || options.book === "shared") {
  fail("--book is the book's folder name: lower-case letters, digits and single hyphens, such as paluxy-portal.");
}

const novels = resolve(options.novels);
if (!existsSync(join(novels, ".git"))) fail(`${novels} is not a Git clone; point --novels at a clone of the novels repository.`);
const bookDir = join(novels, options.book);
if (existsSync(join(bookDir, "chapters"))) {
  fail(`${join(bookDir, "chapters")} already exists. The importer writes a new book only; import into a new folder or move the old chapters first.`);
}

/** Natural order, so 2-name.docx comes before 10-name.docx. */
const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;
/** @type {string[]} */
const files = [];
for (const input of inputs) {
  const path = resolve(input);
  if (!existsSync(path)) fail(`${input} does not exist.`);
  if (statSync(path).isDirectory()) {
    const found = readdirSync(path)
      .filter((f) => f.toLowerCase().endsWith(".docx") && !f.startsWith("~$"))
      .sort(byName)
      .map((f) => join(path, f));
    if (found.length === 0) fail(`${input} has no .docx files.`);
    files.push(...found);
  } else if (path.toLowerCase().endsWith(".docx")) {
    files.push(path);
  } else {
    fail(`${input} is not a .docx file. Export it from Google Docs with File, Download, Microsoft Word.`);
  }
}

const sources = [];
for (const file of files) {
  try {
    const { paragraphs, flags } = await readDocx(new Uint8Array(readFileSync(file)));
    sources.push({ name: basename(file), paragraphs, flags });
  } catch (error) {
    fail(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const book = writeBook(buildBook(sources), { bookFolder: options.book, title: options.title });
for (const [path, content] of book.files) {
  const target = join(bookDir, path);
  if (path === "book.md" && existsSync(target)) continue; // An existing title page is Dustin's; left alone.
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const reportPath = join(bookDir, "build", "import-report.md");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, book.report);

const s = book.summary;
console.log(`Imported ${files.length} file${files.length === 1 ? "" : "s"} into ${bookDir}`);
console.log(`${s.chapters} chapters, ${s.scenes} scenes, ${s.words} words, ${s.flags} flags.`);
console.log(`Report (not committed; build/ is ignored): ${reportPath}`);
if (s.flags > 0) console.log("Every flag is also marked in its file with an <!-- import: ... --> line.");
