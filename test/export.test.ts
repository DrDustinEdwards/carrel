// Export (ePub, Word, the print page for PDF) and the two small parsers under it: scene headers and
// the prose Markdown scenes use. The files are opened again here, not just produced.

import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import type { Assembled } from "~/lib/books.server";
import { buildDocx, buildEpub, parseInline, parseProse, printHtml } from "~/lib/novels/export";
import { list, parseFile, text } from "~/lib/novels/frontmatter";
import { isBookPath, nextNumbered, slugify, titleFromSegment } from "~/lib/novels/layout";

const BOOK: Assembled = {
  title: "The Test Book & Co.",
  author: "Test Author",
  language: "en",
  chapters: [
    { slug: "01-arrival", title: "Arrival", scenes: [{ path: "a", body: "Wade opened the *old* gate.\n\nHe said <nothing>." }, { path: "b", body: "Supper, **late**." }] },
    { slug: "02-letters", title: "Letters", scenes: [{ path: "c", body: "> A letter, read aloud.\n\nThe end." }] },
  ],
};

describe("scene headers", () => {
  it("reads strings, inline lists, dash lists, booleans and quotes, and reports what it cannot read", () => {
    const parsed = parseFile(
      "---\npov: Wade\ncharacters: [Wade, \"Harlan, June\"]\naliases:\n  - Mrs. Harlan\n  - June\nflashback: true\ngoal:\n# a comment\nnonsense here\n---\n\nBody line.\n",
    );
    expect(parsed.data).toEqual({ pov: "Wade", characters: ["Wade", "Harlan, June"], aliases: ["Mrs. Harlan", "June"], flashback: true, goal: "" });
    expect(parsed.problems).toEqual([{ line: 10, text: "nonsense here" }]);
    expect(parsed.bodyLine).toBe(12);
    expect(parsed.body).toBe("\nBody line.\n");
    expect(list(parsed.data, "characters")).toEqual(["Wade", "Harlan, June"]);
    expect(text(parsed.data, "goal")).toBe("");
  });

  it("treats a file with no header, or an unclosed one, as all body", () => {
    expect(parseFile("Just prose.\n")).toMatchObject({ data: {}, bodyLine: 1 });
    expect(parseFile("---\npov: x\n").problems).toHaveLength(1);
  });
});

describe("the layout", () => {
  it("allows the novels layout and nothing else", () => {
    for (const ok of ["book.md", "chapters/01-arrival/01-the-gate.md", "chapters/100-late/12-end.md", "bible/characters/wade.md", "bible/world.md", "outline/plan.md"]) {
      expect(isBookPath(ok), ok).toBe(true);
    }
    for (const bad of ["../x.md", "build/x.md", "chapters/arrival/01-a.md", "chapters/01-a/b.md", "bible/other/x.md", "notes.md", "Book.md", "chapters/01-a/01-b.txt", "outline/a/b.md"]) {
      expect(isBookPath(bad), bad).toBe(false);
    }
  });

  it("names and numbers chapters and scenes", () => {
    expect(titleFromSegment("03-the-long-road")).toBe("The long road");
    expect(slugify("The Crossing, Part II!")).toBe("the-crossing-part-ii");
    expect(slugify("Río Café")).toBe("rio-cafe");
    expect(nextNumbered(["01-a", "02-b", "09-c"], "d")).toBe("10-d");
    expect(nextNumbered([], "first")).toBe("01-first");
  });
});

describe("prose Markdown", () => {
  it("parses emphasis and strong, and leaves unmatched markers and snake_case as text", () => {
    expect(parseInline("a *b* **c** _d_")).toEqual([
      { text: "a ", em: false, strong: false },
      { text: "b", em: true, strong: false },
      { text: " ", em: false, strong: false },
      { text: "c", em: false, strong: true },
      { text: " ", em: false, strong: false },
      { text: "d", em: true, strong: false },
    ]);
    expect(parseInline("2 * 3 and snake_case_name")).toEqual([{ text: "2 * 3 and snake_case_name", em: false, strong: false }]);
    expect(parseInline("\\*literal\\*")).toEqual([{ text: "*literal*", em: false, strong: false }]);
  });

  it("splits paragraphs, scene breaks, headings and quotes; joins hard-wrapped lines", () => {
    expect(parseProse("One\ntwo.\n\n* * *\n\n## Part\n\n> q1\n> q2").map((b) => b.type)).toEqual(["p", "break", "h", "quote"]);
    expect(parseProse("One\ntwo.")[0]).toEqual({ type: "p", inlines: [{ text: "One two.", em: false, strong: false }] });
  });
});

describe("ePub", () => {
  const files = unzipSync(buildEpub(BOOK, { id: "0f0e7c2a-6a8b-4d1e-9d5e-3a4b5c6d7e8f", modified: new Date("2026-09-27T03:00:00.123Z") }));

  it("puts an uncompressed mimetype first, as the container format requires", () => {
    const zip = buildEpub(BOOK, { id: "x", modified: new Date() });
    // Local file header: signature, then compression method at offset 8 (0 = stored), name at 30.
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(zip[8]).toBe(0);
    expect(strFromU8(zip.slice(30, 38))).toBe("mimetype");
    expect(strFromU8(files["mimetype"]!)).toBe("application/epub+zip");
  });

  it("has a package document, a navigation document and one XHTML file per chapter, escaped", () => {
    expect(Object.keys(files).sort()).toEqual([
      "META-INF/container.xml",
      "OEBPS/book.css",
      "OEBPS/chapter-001.xhtml",
      "OEBPS/chapter-002.xhtml",
      "OEBPS/content.opf",
      "OEBPS/nav.xhtml",
      "OEBPS/title.xhtml",
      "mimetype",
    ]);
    const opf = strFromU8(files["OEBPS/content.opf"]!);
    expect(opf).toContain("<dc:title>The Test Book &amp; Co.</dc:title>");
    expect(opf).toContain('<meta property="dcterms:modified">2026-09-27T03:00:00Z</meta>');
    expect(opf).toContain('<itemref idref="c2"/>');
    const one = strFromU8(files["OEBPS/chapter-001.xhtml"]!);
    expect(one).toContain("<h1>Arrival</h1>");
    expect(one).toContain("<p>Wade opened the <em>old</em> gate.</p>");
    expect(one).toContain("He said &lt;nothing&gt;.");
    expect(one).toContain('<p class="scene-break">* * *</p>\n<p>Supper, <strong>late</strong>.</p>');
    expect(strFromU8(files["OEBPS/chapter-002.xhtml"]!)).toContain("<blockquote><p>A letter, read aloud.</p></blockquote>");
    expect(strFromU8(files["OEBPS/nav.xhtml"]!)).toContain('<a href="chapter-002.xhtml">Letters</a>');
  });
});

describe("Word", () => {
  it("is a Word document holding the title, each chapter and the formatting", async () => {
    const files = unzipSync(new Uint8Array(await buildDocx(BOOK)));
    const xml = strFromU8(files["word/document.xml"]!);
    for (const t of ["The Test Book &amp; Co.", "Arrival", "Letters", "Wade opened the ", "old", "* * *", "late"]) expect(xml).toContain(t);
    // The emphasis survives as italics on its own run.
    expect(xml).toMatch(/<w:i\/>[\s\S]*?<w:t[^>]*>old<\/w:t>/);
  });
});

describe("the print page", () => {
  it("is the whole book with each chapter on a new page, escaped", () => {
    const html = printHtml(BOOK);
    expect(html).toContain("<title>The Test Book &amp; Co.</title>");
    expect(html).toContain(".chapter { break-before: page; }");
    expect(html.match(/<section class="chapter">/g)).toHaveLength(2);
    expect(html).not.toContain("<nothing>");
  });
});
