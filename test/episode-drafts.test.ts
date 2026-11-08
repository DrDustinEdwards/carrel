// Which episodes the routine is fired for: those whose summary or chapters are empty.
import { describe, expect, it } from "vitest";

import { needsDraft } from "~/lib/episode-drafts.server";

const source = (excerpt: string, chapters: string) =>
  `---\ntitle: "Pump"\nexcerpt: ${excerpt}\nchapters: ${chapters}\n---\nBody`;

describe("needsDraft", () => {
  it("is true when the summary or the chapters are empty or missing", () => {
    expect(needsDraft(source('""', '[{"start":0,"title":"A"}]'))).toBe(true);
    expect(needsDraft(source('"A summary."', "[]"))).toBe(true);
    expect(needsDraft('---\ntitle: "Pump"\n---\nBody')).toBe(true);
  });
  it("is false when both are filled", () => {
    expect(needsDraft(source('"A summary."', '[{"start":0,"title":"A"}]'))).toBe(false);
  });
});
