// Assembly and export (design section 5, "for sending a book out"): ePub (zipped XHTML) and Word
// built in the Worker, and PDF from the print page in the browser. Scenes are prose, so the Markdown
// they use is small: paragraphs, headings, block quotes, scene breaks, *emphasis* and **strong**.
// Anything else passes through as text rather than being guessed at.

import { AlignmentType, Document, HeadingLevel, Packer, PageBreak, Paragraph, TextRun } from "docx";
import { strToU8, zipSync, type Zippable } from "fflate";

import type { Assembled } from "~/lib/books.server";

export type Inline = { text: string; em: boolean; strong: boolean };
export type Block = { type: "p" | "quote"; inlines: Inline[] } | { type: "h"; level: number; inlines: Inline[] } | { type: "break" };

/** `*a* **b** _c_ __d__`, with a backslash escaping the next character. Unclosed markers are text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let em = false;
  let strong = false;
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf, em, strong });
    buf = "";
  };
  // Markers that have a partner later in the line; the rest are literal.
  const closes = (from: number, marker: string) => text.indexOf(marker, from) !== -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) {
      buf += text[++i];
      continue;
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const marker = ch + ch;
      if (strong || closes(i + 2, marker)) {
        flush();
        strong = !strong;
        i++;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      // An underscore inside a word (snake_case) is text.
      const inWord = ch === "_" && /\w/.test(text[i - 1] ?? "") && /\w/.test(text[i + 1] ?? "");
      if (!inWord && (em || closes(i + 1, ch))) {
        flush();
        em = !em;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return out;
}

export function parseProse(body: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of body.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const raw = chunk.trim();
    if (!raw) continue;
    if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$|^#$/.test(raw)) {
      blocks.push({ type: "break" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading && !raw.includes("\n")) {
      blocks.push({ type: "h", level: heading[1]!.length, inlines: parseInline(heading[2]!.trim()) });
      continue;
    }
    if (raw.split("\n").every((l) => l.startsWith(">"))) {
      const text = raw.split("\n").map((l) => l.replace(/^>\s?/, "")).join(" ");
      blocks.push({ type: "quote", inlines: parseInline(text) });
      continue;
    }
    // Hard wraps inside a paragraph are one paragraph; a line ending in two spaces is not kept.
    blocks.push({ type: "p", inlines: parseInline(raw.split("\n").map((l) => l.trim()).join(" ")) });
  }
  return blocks;
}

// ---------- XHTML, for ePub and the print page

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inlineHtml(inlines: Inline[]): string {
  return inlines
    .map((i) => {
      let html = escapeXml(i.text);
      if (i.em) html = `<em>${html}</em>`;
      if (i.strong) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

export function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "break":
          return `<p class="scene-break">* * *</p>`;
        case "h": {
          // Chapter titles are h1 in the assembled book, so a heading inside a scene sits below them.
          const level = Math.min(6, b.level + 1);
          return `<h${level}>${inlineHtml(b.inlines)}</h${level}>`;
        }
        case "quote":
          return `<blockquote><p>${inlineHtml(b.inlines)}</p></blockquote>`;
        default:
          return `<p>${inlineHtml(b.inlines)}</p>`;
      }
    })
    .join("\n");
}

/** A chapter's scenes, separated by scene breaks, as the chapter's body. */
export function chapterBlocks(chapter: Assembled["chapters"][number]): Block[] {
  const out: Block[] = [];
  chapter.scenes.forEach((scene, i) => {
    if (i > 0) out.push({ type: "break" });
    out.push(...parseProse(scene.body));
  });
  return out;
}

const BOOK_CSS = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; }
h1 { text-align: center; margin: 3em 0 2em; font-weight: normal; }
p { margin: 0; text-indent: 1.5em; }
h1 + p, h2 + p, .scene-break + p, blockquote + p { text-indent: 0; }
.scene-break { text-align: center; text-indent: 0; margin: 1em 0; }
blockquote { margin: 1em 2em; font-style: italic; }
`;

// ---------- ePub 3

export function slugFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "book";
}

export function buildEpub(book: Assembled, opts: { id: string; modified: Date }): Uint8Array<ArrayBuffer> {
  const chapterFiles = book.chapters.map((c, i) => ({ file: `chapter-${String(i + 1).padStart(3, "0")}.xhtml`, chapter: c }));
  const xhtml = (title: string, body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(book.language)}" xml:lang="${escapeXml(book.language)}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="book.css"/></head>
<body>
${body}
</body>
</html>
`;
  const modified = opts.modified.toISOString().replace(/\.\d{3}Z$/, "Z");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${escapeXml(opts.id)}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author)}</dc:creator>
    <dc:language>${escapeXml(book.language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="book.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${chapterFiles.map((c, i) => `    <item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`).join("\n")}
  </manifest>
  <spine>
    <itemref idref="title"/>
${chapterFiles.map((_, i) => `    <itemref idref="c${i + 1}"/>`).join("\n")}
  </spine>
</package>
`;
  const nav = xhtml(
    book.title,
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapterFiles.map((c) => `<li><a href="${c.file}">${escapeXml(c.chapter.title)}</a></li>`).join("\n")}
</ol></nav>`,
  );
  const files: Zippable = {
    // The mimetype comes first and uncompressed, as the ePub container requires.
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/nav.xhtml": strToU8(nav),
    "OEBPS/book.css": strToU8(BOOK_CSS),
    "OEBPS/title.xhtml": strToU8(xhtml(book.title, `<h1>${escapeXml(book.title)}</h1>\n<p class="scene-break">${escapeXml(book.author)}</p>`)),
  };
  for (const c of chapterFiles) {
    files[`OEBPS/${c.file}`] = strToU8(xhtml(c.chapter.title, `<h1>${escapeXml(c.chapter.title)}</h1>\n${blocksToHtml(chapterBlocks(c.chapter))}`));
  }
  // Copied into an ArrayBuffer-backed array, which a Response body requires.
  return new Uint8Array(zipSync(files));
}

// ---------- Word

function runs(inlines: Inline[]): TextRun[] {
  return inlines.map((i) => new TextRun({ text: i.text, italics: i.em, bold: i.strong }));
}

export async function buildDocx(book: Assembled): Promise<ArrayBuffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(book.title)] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(book.author)] }),
  ];
  for (const chapter of book.chapters) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, children: [new TextRun(chapter.title)] }));
    for (const b of chapterBlocks(chapter)) {
      if (b.type === "break") children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun("* * *")] }));
      else if (b.type === "h") children.push(new Paragraph({ heading: b.level <= 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, children: runs(b.inlines) }));
      else if (b.type === "quote") children.push(new Paragraph({ indent: { left: 720, right: 720 }, children: runs(b.inlines) }));
      else children.push(new Paragraph({ indent: { firstLine: 360 }, children: runs(b.inlines) }));
    }
  }
  const doc = new Document({ creator: book.author, title: book.title, sections: [{ children }] });
  return Packer.toArrayBuffer(doc);
}

// ---------- the print page, for PDF from the browser

export function printHtml(book: Assembled): string {
  const chapters = book.chapters
    .map((c) => `<section class="chapter"><h1>${escapeXml(c.title)}</h1>\n${blocksToHtml(chapterBlocks(c))}</section>`)
    .join("\n");
  return `<!doctype html>
<html lang="${escapeXml(book.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(book.title)}</title>
<style>
${BOOK_CSS}
body { max-width: 34rem; margin: 2rem auto; padding: 0 1rem; font-size: 12pt; }
.title-page { text-align: center; margin: 30vh 0; }
.chapter { break-before: page; }
.hint { font-family: system-ui, sans-serif; font-size: 10pt; color: #555; border: 1px solid #ccc; padding: 0.5rem 0.75rem; }
@page { size: 6in 9in; margin: 0.75in; }
@media print { .hint { display: none; } body { margin: 0; max-width: none; } }
</style>
</head>
<body>
<p class="hint">Print this page and choose Save as PDF. The page size is 6 by 9 inches.</p>
<section class="title-page"><h1>${escapeXml(book.title)}</h1><p class="scene-break">${escapeXml(book.author)}</p></section>
${chapters}
</body>
</html>
`;
}
