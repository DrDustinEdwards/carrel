// The formatted editor's Markdown underneath (job_1ba8094853f5): a file opened and saved with no
// edit comes back byte for byte, and an edit changes only the bytes of the block it touched. The
// corpus in test/fixtures/markdown is written for this test (every construct, in each spelling); real
// content is checked by scripts/check-roundtrip.mjs, which CI runs over dustinedwards.info's content.

import { describe, expect, it } from "vitest";

import { fingerprints, fromDoc, pastedBlocks, toDoc, writeChecked, type JsonNode } from "~/lib/editor/markdown.mjs";
import { editorSchema } from "~/lib/editor/schema.mjs";

const corpus = import.meta.glob("./fixtures/markdown/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const schema = editorSchema();

/** Open a file as the editor does: parse, load into the schema, take the prints of what loaded. */
function open(source: string, dialect: "site" | "plain" = "site") {
  const loaded = toDoc(source, dialect);
  const doc = schema.nodeFromJSON(loaded.doc).toJSON() as JsonNode;
  const prints = fingerprints(doc);
  const save = (edited: JsonNode = doc) => fromDoc(schema.nodeFromJSON(edited).toJSON() as JsonNode, loaded.tail, prints, dialect);
  return { doc, save, copy: () => JSON.parse(JSON.stringify(doc)) as JsonNode };
}

const blocks = (doc: JsonNode) => doc.content!;

describe("a save with no edit", () => {
  it("has the construct corpus", () => {
    expect(Object.keys(corpus).length).toBeGreaterThanOrEqual(9);
  });

  for (const [name, source] of Object.entries(corpus)) {
    for (const dialect of ["site", "plain"] as const) {
      it(`PLANT: gives back ${name.replace("./fixtures/markdown/", "")} byte for byte (${dialect})`, () => {
        expect(open(source, dialect).save()).toBe(source);
      });
    }
  }

  it("keeps formatted prose formatted and the rest as source", () => {
    const { doc } = open(corpus["./fixtures/markdown/site.md"]!);
    expect(blocks(doc).map((b) => [b.type, b.attrs?.kind ?? null])).toEqual([
      ["sourceBlock", "Front matter"],
      ["sourceBlock", "Figure"],
      ["sourceBlock", "Chart"],
      ["sourceBlock", "Diagram"],
      ["sourceBlock", "Details"],
      ["sourceBlock", "Leaf"],
      ["paragraph", null],
      ["paragraph", null],
      ["sourceBlock", "Math"],
      ["paragraph", null],
    ]);
    const text = blocks(doc)[6]!.content!;
    expect(text.filter((n) => n.type === "sourceInline").map((n) => n.attrs!.text)).toEqual([":pullquote[a raised line]", ":swatch[#4F2D7F]"]);
    // A ratio and a port are text, as the site reads them.
    expect(text.map((n) => n.text ?? "").join("")).toContain("4.5:1 and localhost:8080");
  });
});

describe("an edit", () => {
  const source = "---\ntitle: T\n---\n\nFirst *one*.\n\nSecond  \nline.\n\n| a |\n| - |\n| b |\n";

  it("PLANT: changes only the bytes of the block it touched", () => {
    const { copy, save } = open(source);
    const edited = copy();
    blocks(edited)[1]!.content!.push({ type: "text", text: " More." });
    expect(save(edited)).toBe("---\ntitle: T\n---\n\nFirst *one*. More.\n\nSecond  \nline.\n\n| a |\n| - |\n| b |\n");
  });

  it("puts a new block after a blank line, before what followed the last block", () => {
    const { copy, save } = open(source);
    const edited = copy();
    blocks(edited).push({ type: "paragraph", content: [{ type: "text", text: "New." }] });
    expect(save(edited)).toBe(`${source.slice(0, -1)}\n\nNew.\n`);
  });

  it("drops a deleted block with the bytes before it", () => {
    const { copy, save } = open(source);
    const edited = copy();
    blocks(edited).splice(2, 1);
    expect(save(edited)).toBe("---\ntitle: T\n---\n\nFirst *one*.\n\n| a |\n| - |\n| b |\n");
  });

  it("writes an edited source block exactly as typed", () => {
    const { copy, save } = open(source);
    const edited = copy();
    blocks(edited)[0]!.attrs!.text = "---\ntitle: Renamed\n---";
    expect(save(edited)).toBe(source.replace("title: T", "title: Renamed"));
  });

  it("keeps Windows line endings in the blocks it did not touch", () => {
    const crlf = corpus["./fixtures/markdown/crlf.md"]!;
    const { copy, save } = open(crlf, "plain");
    const edited = copy();
    blocks(edited)[2]!.content![0]!.text = "Second, edited.";
    expect(save(edited)).toBe(crlf.replace("Second paragraph.", "Second, edited."));
  });
});

describe("spelling a changed block", () => {
  const para = (text: string, marks?: JsonNode["marks"]) => ({ type: "paragraph", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] }) as JsonNode;

  it("escapes what would otherwise be read as Markdown, and leaves the rest alone", () => {
    expect(writeChecked(para("2*3 is [GPS] & snake_case, not *emphasis*."), "site")).toBe("2\\*3 is [GPS] & snake_case, not \\*emphasis\\*.");
    expect(writeChecked(para("# not a heading"), "plain")).toBe("\\# not a heading");
    expect(writeChecked(para("1. not a list"), "plain")).toBe("1\\. not a list");
    expect(writeChecked(para("[text](not a link)"), "plain")).toBe("\\[text](not a link)");
  });

  it("escapes a colon before a word only in a site's Markdown, where it would start a directive", () => {
    expect(writeChecked(para("Note:here and 10:30"), "site")).toBe("Note\\:here and 10:30");
    expect(writeChecked(para("Note:here and 10:30"), "plain")).toBe("Note:here and 10:30");
  });

  it("keeps the block's own emphasis spelling and moves edge spaces out of the marks", () => {
    const loaded = toDoc("Use _this_ form.\n", "plain").doc.content![0]!;
    loaded.content!.push({ type: "text", text: " And ", marks: [{ type: "italic" }] }, { type: "text", text: "more." });
    expect(writeChecked(loaded, "plain")).toBe("Use _this_ form. _And_ more.");
    expect(writeChecked(para("bold ", [{ type: "bold" }]), "plain")).toBe("**bold** ");
  });

  it("writes lists, quotes and headings in the house style", () => {
    const list = toDoc("- a\n- b\n", "plain").doc.content![0]!;
    list.content![1]!.content![0]!.content![0]!.text = "b, edited";
    expect(writeChecked(list, "plain")).toBe("- a\n- b, edited");
    const quote = toDoc("> one\n> two\n", "plain").doc.content![0]!;
    expect(writeChecked(quote, "plain")).toBe("> one\n> two");
    expect(writeChecked({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] }, "plain")).toBe("## Title");
  });

  it("reads pasted Markdown as new blocks, with no origin", () => {
    const pasted = pastedBlocks("## Pasted\n\nWith **bold**.\n", "plain");
    expect(pasted.map((b) => [b.type, b.attrs?.md ?? null])).toEqual([
      ["heading", null],
      ["paragraph", null],
    ]);
  });
});
