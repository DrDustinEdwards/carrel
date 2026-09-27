// The manuscript importer (scripts/import-docx.mjs) on the short test document Dustin chose, and on
// a document of planted problems it must flag instead of guessing at. The documents are real .docx
// files, zipped here from the XML in test/fixtures/import/test-manuscript.mjs.

import { describe, expect, it } from "vitest";

import { readDocumentXml, readDocx, readZip } from "../scripts/lib/docx.mjs";
import { buildBook, runsToMarkdown, slugify, writeBook } from "../scripts/lib/manuscript.mjs";

import { documentXml, docx, p, PROBLEMS, r, TEST_MANUSCRIPT, zip } from "./fixtures/import/test-manuscript.mjs";

async function importDocs(docs: Record<string, string>, bookFolder = "import-test") {
  const sources = [];
  for (const [name, xml] of Object.entries(docs)) sources.push({ name, ...(await readDocx(await docx(xml))) });
  return writeBook(buildBook(sources), { bookFolder });
}

const HEADER = "---\npov:\ndate:\nlocation:\ncharacters: []\ngoal:\nconflict:\noutcome:\n---\n\n";

describe("the test manuscript", () => {
  it("becomes two chapters, the first split at its scene break, with italics and bold kept", async () => {
    const book = await importDocs({ "test-manuscript.docx": TEST_MANUSCRIPT });
    expect([...book.files.keys()]).toEqual([
      "chapters/01-arrival/01-the-truck-quit-a-mile.md",
      "chapters/01-arrival/02-at-the-gate-there-was.md",
      "chapters/02-the-letters/01-wade-set-the-envelope-on.md",
      "book.md",
    ]);
    expect(book.files.get("chapters/01-arrival/01-the-truck-quit-a-mile.md")).toBe(
      `${HEADER}The truck quit a mile past the *low-water* crossing. I let it roll to the shoulder.\n\nI walked the rest of the way. The river was **loud**, and the cedar smelled like pencil shavings.\n`,
    );
    expect(book.files.get("chapters/01-arrival/02-at-the-gate-there-was.md")).toBe(`${HEADER}At the gate there was a new lock, brass, and it was shut.\n`);
    // The space inside the italic run moves outside its markers.
    expect(book.files.get("chapters/02-the-letters/01-wade-set-the-envelope-on.md")).toBe(
      `${HEADER}Wade set the envelope on the table. *It's got your name on it,* he said.\n\nI did not open it. Not that night.\n`,
    );
    expect(book.files.get("book.md")).toBe("---\ntitle: The Crossing (a test manuscript)\nauthor:\nlanguage: en\n---\n");
    expect(book.summary).toMatchObject({ chapters: 2, scenes: 3, flags: 0, title: "The Crossing (a test manuscript)" });
    expect(book.report).toContain("Nothing was flagged.");
  });

  it("reads the same from a stored (uncompressed) archive as from a deflated one", async () => {
    const stored = await readDocx(await docx(TEST_MANUSCRIPT, { deflate: false }));
    const deflated = await readDocx(await docx(TEST_MANUSCRIPT));
    expect(stored).toEqual(deflated);
  });

  it("ignores italics set on the paragraph mark, which style no text", () => {
    const { paragraphs } = readDocumentXml(TEST_MANUSCRIPT);
    expect(paragraphs[2]!.runs.map((run) => run.italic)).toEqual([false, true, false]);
  });

  it("treats a folder of files as chapters in order, a file with no heading as one chapter", async () => {
    const book = await importDocs({
      "01-arrival.docx": documentXml(p(r("First words here."))),
      "02-letters.docx": documentXml(p(r("Second words here."))),
    });
    expect([...book.files.keys()].filter((k) => k.startsWith("chapters/"))).toEqual([
      "chapters/01-01-arrival/01-first-words-here.md",
      "chapters/02-02-letters/01-second-words-here.md",
    ]);
  });
});

describe("PLANT: what the importer flags instead of guessing", () => {
  it("marks each problem where it happened and lists it in the report", async () => {
    const book = await importDocs({ "problems.docx": PROBLEMS });
    const what = book.flags.map((f) => f.what);
    for (const expected of ["table", "image", "footnote", "tracked-change", "list", "line-break", "blank-lines", "heading", "centered", "page-break", "front-matter"]) {
      expect(what, expected).toContain(expected);
    }
    // Every placed flag is an HTML comment on the line the report names.
    for (const f of book.flags.filter((flag) => flag.line !== null)) {
      const lines = book.files.get(f.where)!.split("\n");
      expect(lines[f.line! - 1], `${f.where}:${f.line} ${f.what}`).toMatch(/^<!-- import: /);
    }
    expect(book.report).toMatch(/^# Import report: import-test\n\n1 chapter, 1 scene, \d+ words, \d+ flags\./);
  });

  it("keeps the text around a problem, and drops only what cannot be text", async () => {
    const book = await importDocs({ "problems.docx": PROBLEMS });
    const scene = book.files.get([...book.files.keys()].find((k) => k.startsWith("chapters/"))!)!;
    expect(scene).toContain("Plain not italic and *styled*.");
    expect(scene).not.toContain("cell text");
    expect(scene).toContain("An image:  and a note.");
    expect(scene).toContain("Kept inserted text.");
    expect(scene).not.toContain("deleted");
    expect(scene).toContain("Line one\nline two");
    expect(scene).toContain("## A part");
    // Markdown in the writer's own text is escaped, so it stays text.
    expect(scene).toContain("\\# not a heading, \\*not\\* emphasis\\_either");
    expect(scene).toContain("Smart “quotes” stay, and so does café.");
    // Text before the first chapter heading is kept, out of the story.
    expect(book.files.get("outline/imported-front-matter.md")).toContain("A note before the story, 3 \\* 4 = 12.");
  });

  it("refuses a file that is not a Word document", async () => {
    await expect(readDocx(new TextEncoder().encode("not a zip"))).rejects.toThrow("This is not a ZIP archive, so it is not a .docx file.");
    await expect(readDocx(await zip({ "hello.txt": "hi" }))).rejects.toThrow("The archive has no word/document.xml");
    expect((await readZip(await zip({ "a.txt": "x", "b/c.txt": "y" }, { deflate: true }))).size).toBe(2);
  });
});

describe("Markdown for runs and names", () => {
  it("closes emphasis around the words, not the spaces, and marks bold italic", () => {
    expect(runsToMarkdown([{ text: "a ", italic: false, bold: false }, { text: " b ", italic: true, bold: false }, { text: "c", italic: true, bold: true }])).toBe("a  *b* ***c***");
    expect(runsToMarkdown([{ text: "1. Not a list", italic: false, bold: false }])).toBe("1\\. Not a list");
  });

  it("names folders and files as the novels layout requires", () => {
    expect(slugify("The Crossing, Part II!")).toBe("the-crossing-part-ii");
    expect(slugify("Río Café")).toBe("rio-cafe");
    expect(slugify("***")).toBe("");
  });
});
