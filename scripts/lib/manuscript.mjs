// Turns the paragraphs of one or more Word files into a book in the novels layout: a folder per
// chapter (chapters/NN-name/), a Markdown file per scene (NN-name.md) opening with an empty scene
// header for Dustin to fill, italics as *...* and bold as **...**. Anything that did not convert
// cleanly is marked where it happened with an HTML comment and listed in the report, never guessed.

import { headingOf } from "./docx.mjs";

/**
 * @typedef {import("./docx.mjs").Paragraph} Paragraph
 * @typedef {import("./docx.mjs").DocFlag} DocFlag
 * @typedef {import("./docx.mjs").Run} Run
 * @typedef {{ name: string, paragraphs: Paragraph[], flags: DocFlag[] }} SourceFile
 * @typedef {{ file: string, where: string, line: number | null, what: string, detail: string }} ImportFlag
 * @typedef {{ kind: "text", markdown: string, source: string, index: number } | { kind: "note", text: string }} Block
 * @typedef {{ blocks: Block[] }} Scene
 * @typedef {{ title: string, source: string, scenes: Scene[] }} Chapter
 */

const SCENE_HEADER = ["---", "pov:", "date:", "location:", "characters: []", "goal:", "conflict:", "outcome:", "---", "", ""].join("\n");

/** A paragraph that is only a scene-break mark: "* * *", "***", "#", "~", a bullet, or a rule. */
const SCENE_BREAK = /^(?:(?:[*#~•·]\s*){1,5}|(?:-\s*){3,}|(?:_\s*){3,})$/u;

/** @param {string} title */
export function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
}

/** @param {number} n */
function number(n) {
  return String(n).padStart(2, "0");
}

/** Characters Markdown would read as formatting, escaped so the text stays text. */
function escapeInline(/** @type {string} */ text) {
  return text.replace(/([\\*_`[\]<])/g, "\\$1");
}

/** A line start Markdown would read as a heading, quote, list or rule. */
function escapeLineStart(/** @type {string} */ line) {
  return line
    .replace(/^(\s*)([#>+-])(\s|$)/, (_, space, mark, after) => `${space}\\${mark}${after}`)
    .replace(/^(\s*\d+)([.)])(\s|$)/, (_, digits, mark, after) => `${digits}\\${mark}${after}`);
}

/**
 * Runs to Markdown. Spaces at the edge of an italic or bold run move outside its markers, because
 * `*word *` is not emphasis in Markdown.
 * @param {Run[]} runs
 */
export function runsToMarkdown(runs) {
  let out = "";
  for (const run of runs) {
    const text = escapeInline(run.text);
    const marker = run.italic && run.bold ? "***" : run.bold ? "**" : run.italic ? "*" : "";
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const [, lead, core, trail] = m ?? ["", "", text, ""];
    out += marker && core ? `${lead}${marker}${core}${marker}${trail}` : text;
  }
  return out
    .split("\n")
    .map((line) => escapeLineStart(line.replace(/[ \t]+$/g, "")))
    .join("\n")
    .trim();
}

/** @param {Paragraph} p */
function plainText(p) {
  return p.runs.map((r) => r.text).join("");
}

/**
 * Builds the chapters from the files in order. A Heading 1 starts a chapter; a file with no Heading 1
 * is one chapter named after the file. Text before a file's first Heading 1 is front matter, kept
 * apart from the story. A scene-break paragraph starts a new scene.
 * @param {SourceFile[]} sources
 */
export function buildBook(sources) {
  /** @type {Chapter[]} */
  const chapters = [];
  /** @type {Block[]} */
  const frontMatter = [];
  let title = "";

  for (const source of sources) {
    const hasChapters = source.paragraphs.some((p) => headingOf(p)?.level === 1);
    /** @type {Chapter | null} */
    let chapter = null;
    if (!hasChapters) {
      chapter = { title: source.name.replace(/\.docx$/i, ""), source: source.name, scenes: [{ blocks: [] }] };
      chapters.push(chapter);
    }
    /** @type {Map<number, DocFlag[]>} */
    const flagsAt = new Map();
    for (const f of source.flags) flagsAt.set(f.paragraph, [...(flagsAt.get(f.paragraph) ?? []), f]);
    let blanks = 0;

    /** The blocks the next paragraph goes into: the open scene, or front matter before any chapter. */
    const current = () => (chapter ? /** @type {Scene} */ (chapter.scenes.at(-1)).blocks : frontMatter);
    /** @param {string} text */
    const note = (text) => current().push({ kind: "note", text });
    const hasText = () => current().some((b) => b.kind === "text");

    source.paragraphs.forEach((p, index) => {
      const heading = headingOf(p);
      const text = plainText(p);
      for (const f of flagsAt.get(index) ?? []) note(`${f.what}: ${f.detail}`);

      if (heading?.kind === "title") {
        if (!title) title = text.trim();
        else note(`title: A second title, "${text.trim()}", was left out.`);
        return;
      }
      if (heading?.kind === "subtitle") {
        note(`subtitle: The subtitle "${text.trim()}" was left out; put it in book.md if it belongs.`);
        return;
      }
      if (heading?.level === 1) {
        chapter = { title: text.trim() || "Untitled", source: source.name, scenes: [{ blocks: [] }] };
        chapters.push(chapter);
        blanks = 0;
        return;
      }

      if (text.trim() === "") {
        blanks++;
        if (p.pageBreak && chapter && hasText()) note("page-break: A page break inside a chapter was dropped; if it marked a scene break, add one.");
        return;
      }
      if (blanks >= 2 && hasText()) note("blank-lines: Several empty paragraphs here may have marked a scene break; none was assumed.");
      blanks = 0;

      if (SCENE_BREAK.test(text.trim())) {
        // A break before any text, or two in a row, makes no scene.
        if (chapter && hasText()) chapter.scenes.push({ blocks: [] });
        return;
      }

      let markdown = runsToMarkdown(p.runs);
      if (heading && heading.level >= 2) {
        markdown = `## ${markdown}`;
        note(`heading: A Heading ${heading.level} was kept as a heading inside the scene.`);
      }
      if (p.lineBreaks > 0) note("line-break: Line breaks inside this paragraph were kept; Carrel's export joins them into one line.");
      if (p.center && !heading) note("centered: This paragraph was centered in Word; the centering was dropped.");
      if (p.pageBreak) note("page-break: A page break in this paragraph was dropped.");
      current().push({ kind: "text", markdown, source: source.name, index });
    });
    // Something after the last paragraph (a table that ends the file) is marked at the end.
    for (const f of flagsAt.get(source.paragraphs.length) ?? []) note(`${f.what}: ${f.detail}`);
  }

  // A scene with no text (a break at the very end of a chapter) is not a scene; its notes, if any,
  // move to the scene before it so no flag is lost.
  for (const c of chapters) {
    c.scenes = c.scenes.filter((s, i) => {
      if (i === 0 || s.blocks.some((b) => b.kind === "text")) return true;
      /** @type {Scene} */ (c.scenes[i - 1]).blocks.push(...s.blocks);
      return false;
    });
  }
  return { title, chapters, frontMatter };
}

/**
 * The scene's name: the first few words of its first paragraph.
 * @param {Scene} scene
 */
function sceneName(scene) {
  const first = scene.blocks.find((b) => b.kind === "text");
  const words = first && first.kind === "text" ? first.markdown.replace(/[\\*_#]/g, "").split(/\s+/).slice(0, 5).join(" ") : "";
  return slugify(words) || "scene";
}

/**
 * The files to write, relative to the book's folder, and the report of everything flagged.
 * @param {ReturnType<typeof buildBook>} book
 * @param {{ bookFolder: string, title?: string }} opts
 */
export function writeBook(book, opts) {
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {ImportFlag[]} */
  const flags = [];
  let words = 0;

  /**
   * @param {string} path
   * @param {string} header
   * @param {Block[]} blocks
   * @param {string} file
   */
  const render = (path, header, blocks, file) => {
    let body = header;
    let line = header.split("\n").length;
    for (const b of blocks) {
      const chunk = b.kind === "text" ? b.markdown : `<!-- import: ${b.text.replace(/--+/g, "-")} -->`;
      if (b.kind === "note") {
        const [what, ...rest] = b.text.split(": ");
        flags.push({ file, where: path, line, what: what ?? "", detail: rest.join(": ") });
      } else {
        words += b.markdown.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      }
      body += `${chunk}\n\n`;
      line += chunk.split("\n").length + 1;
    }
    files.set(path, `${body.replace(/\n+$/, "")}\n`);
  };

  book.chapters.forEach((chapter, ci) => {
    const folder = `chapters/${number(ci + 1)}-${slugify(chapter.title) || "chapter"}`;
    chapter.scenes.forEach((scene, si) => {
      render(`${folder}/${number(si + 1)}-${sceneName(scene)}.md`, SCENE_HEADER, scene.blocks, chapter.source);
    });
  });
  if (book.frontMatter.length > 0) {
    render("outline/imported-front-matter.md", "", book.frontMatter, "");
    flags.push({ file: "", where: "outline/imported-front-matter.md", line: null, what: "front-matter", detail: "Text before the first chapter heading was kept here, out of the story." });
  }
  const title = opts.title || book.title || opts.bookFolder;
  files.set("book.md", ["---", `title: ${title}`, "author:", "language: en", "---", ""].join("\n"));

  const scenes = book.chapters.reduce((n, c) => n + c.scenes.length, 0);
  const report = [
    `# Import report: ${title}`,
    "",
    `${book.chapters.length} chapter${book.chapters.length === 1 ? "" : "s"}, ${scenes} scene${scenes === 1 ? "" : "s"}, ${words} words, ${flags.length} flag${flags.length === 1 ? "" : "s"}.`,
    "",
    "Each flag below is also marked in its file with an `<!-- import: ... -->` line. Fix the text or delete the line; either way, remove every marker before exporting. Scene headers are empty: point of view, date, location, characters and the beats are yours to fill.",
    "",
    ...(flags.length === 0
      ? ["Nothing was flagged."]
      : ["| File | Line | What | Detail | From |", "| --- | ---: | --- | --- | --- |", ...flags.map((f) => `| ${f.where} | ${f.line ?? ""} | ${f.what} | ${f.detail.replace(/\|/g, "\\|")} | ${f.file} |`)]),
    "",
  ].join("\n");
  return { files, report, flags, summary: { chapters: book.chapters.length, scenes, words, flags: flags.length, title } };
}
