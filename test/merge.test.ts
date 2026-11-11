// The merge view's plan: an untouched text comes back byte for byte, a block only one side changed
// starts on that side, a block both changed is the person's to choose, and frontmatter keys merge one
// by one.

import { describe, expect, it } from "vitest";

import { choicesOf, merged, startPicks } from "~/lib/merge";
import { mergePlan } from "~/lib/merge.server";

const BASE = [
  "---",
  'title: "Sample"',
  "tags: [a]",
  "---",
  "",
  "One.",
  "",
  "Two.",
  "",
  "Three.",
  "",
].join("\n");

describe("mergePlan", () => {
  it("gives the text back byte for byte when nothing differs", () => {
    const odd = `${BASE}\n\n\n\`\`\`\ncode\n\n\nmore\n\`\`\`\n`;
    const plan = mergePlan(odd, odd, odd);
    expect(choicesOf(plan)).toHaveLength(0);
    expect(merged(plan, [])).toBe(odd);
  });

  it("starts each block on the side that changed it, and the person's where both did", () => {
    const mine = BASE.replace("One.", "One, mine.").replace("Three.", "Three, mine.");
    const theirs = BASE.replace("Two.", "Two, site.")
      .replace("Three.", "Three, site.")
      .replace("tags: [a]", "tags: [a, b]");
    const plan = mergePlan(mine, theirs, BASE);
    const choices = choicesOf(plan);
    expect(choices.map((c) => c.changedBy)).toEqual(["theirs", "mine", "theirs", null]);
    const out = merged(plan, startPicks(plan));
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("One, mine.");
    expect(out).toContain("Two, site.");
    expect(out).toContain("Three, mine.");
    expect(out).not.toContain("Three, site.");
    // Both keeps the two, the person's first.
    const both = merged(
      plan,
      startPicks(plan).map((p, i) => (i === 3 ? "both" : p)),
    );
    expect(both).toContain("Three, mine.\n\nThree, site.\n");
  });

  it("takes a change both made the same way without asking", () => {
    const edited = BASE.replace("Two.", "Two, fixed.");
    const plan = mergePlan(edited, edited.replace("Three.", "Three, site."), BASE);
    expect(choicesOf(plan).map((c) => c.changedBy)).toEqual(["theirs"]);
    expect(merged(plan, startPicks(plan))).toBe(edited.replace("Three.", "Three, site."));
  });

  it("without a base, starts every difference on the person's text", () => {
    const mine = BASE.replace("One.", "One, mine.");
    const theirs = BASE.replace("Two.", "Two, site.");
    const plan = mergePlan(mine, theirs, null);
    expect(plan.hasBase).toBe(false);
    expect(choicesOf(plan).every((c) => c.changedBy === null && c.start === "mine")).toBe(true);
    expect(merged(plan, startPicks(plan))).toBe(mine);
  });
});
