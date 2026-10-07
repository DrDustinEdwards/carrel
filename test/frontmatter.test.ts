// The frontmatter fields in the editor: the source goes out and comes back unchanged unless a
// field was changed, and an unknown key, a comment or a list the fields do not show survives.

import { describe, expect, it } from "vitest";

import { joinSource, readFields, setField, setRawKey, setTags, splitSource, tagsOf } from "~/lib/frontmatter";

const SOURCE = [
  "---",
  'title: "Every product"',
  "slug: every-product",
  "# kept: a comment",
  'description: "One table."',
  "date: 2026-07-30",
  "draft: false",
  "tags: [cloudflare, workers]",
  "further_reading:",
  "  - https://example.test/a",
  "key_takeaways:",
  '  - "First."',
  '  - "Second."',
  "weird_key: some value: with a colon",
  "---",
  "",
  "The body.",
  "",
].join("\n");

describe("splitSource and joinSource", () => {
  it("round-trips every shape of source byte for byte", () => {
    for (const source of [SOURCE, "no frontmatter\n", "---\ntitle: x\n---", "---\r\ntitle: x\r\n---\r\nBody\r\n", "---\n---\nBody", ""]) {
      expect(joinSource(splitSource(source))).toBe(source);
    }
    expect(splitSource(SOURCE).body).toBe("The body.\n");
  });
});

describe("the fields", () => {
  it("reads them, quoted or not, with tags and takeaways as lists", () => {
    const fields = readFields(splitSource(SOURCE).front);
    expect(fields).toMatchObject({ title: "Every product", description: "One table.", date: "2026-07-30", tags: "cloudflare, workers", key_takeaways: "First.\nSecond.", assumed_audience: "" });
  });

  it("leaves the source untouched when a field is set to what it already holds", () => {
    let front = splitSource(SOURCE).front!;
    for (const [key, value] of Object.entries(readFields(front))) front = setField(front, key as never, value);
    expect(front).toBe(splitSource(SOURCE).front);
  });

  it("changes only the edited block and keeps unknown keys, comments and lists exactly", () => {
    const parts = splitSource(SOURCE);
    const edited = setField(setField(parts.front!, "title", 'A "new" title'), "tags", "a, b, c");
    const out = joinSource({ ...parts, front: edited });
    expect(out).toContain('title: "A \\"new\\" title"');
    expect(out).toContain("tags: [a, b, c]");
    for (const kept of ["slug: every-product", "# kept: a comment", "further_reading:\n  - https://example.test/a", "weird_key: some value: with a colon", "draft: false", '  - "Second."']) {
      expect(out).toContain(kept);
    }
    expect(out.endsWith("---\n\nThe body.\n")).toBe(true);
  });

  it("adds a field the frontmatter lacks and removes one that is emptied", () => {
    const front = splitSource(SOURCE).front!;
    expect(setField(front, "assumed_audience", "Developers.")).toContain('assumed_audience: "Developers."');
    expect(setField(front, "description", "")).not.toContain("description:");
    expect(setField(front, "key_takeaways", "One\nTwo")).toContain('key_takeaways:\n  - "One"\n  - "Two"');
  });
});

describe("bulk edits: tags and one raw key", () => {
  const parts = splitSource(SOURCE);

  it("changes only the tags line and returns every other byte of the file as it was", () => {
    expect(tagsOf(parts.front)).toEqual(["cloudflare", "workers"]);
    const out = joinSource({ ...parts, front: setTags(parts.front!, ["cloudflare", "workers", "edge"]) });
    expect(out).toBe(SOURCE.replace("tags: [cloudflare, workers]", "tags: [cloudflare, workers, edge]"));
  });

  it("writes an emptied list as tags: [], where setField would drop the key", () => {
    expect(setTags(parts.front!, [])).toContain("tags: []");
    expect(setField(parts.front!, "tags", "")).not.toContain("tags:");
  });

  it("leaves the frontmatter as it was when the tags are already that list, and adds the key when it is missing", () => {
    expect(setTags(parts.front!, ["cloudflare", "workers"])).toBe(parts.front);
    expect(setTags("title: x", ["a"])).toBe("title: x\ntags: [a]");
  });

  it("turns a block-form list into the flow form and touches nothing else", () => {
    const front = "title: x\ntags:\n  - a\n  - b\nslug: y";
    expect(setTags(front, ["a", "b", "c"])).toBe("title: x\ntags: [a, b, c]\nslug: y");
  });

  it("sets one raw key in place or at the end, and never rewrites a line that already says it", () => {
    expect(setRawKey(parts.front!, "draft", "true")).toBe(parts.front!.replace("draft: false", "draft: true"));
    expect(setRawKey("title: x", "draft", "true")).toBe("title: x\ndraft: true");
    expect(setRawKey(parts.front!, "draft", "false")).toBe(parts.front);
  });
});
