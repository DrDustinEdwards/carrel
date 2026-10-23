// The logic behind `npm run check:bloat` (scripts/lib/bloat.mjs): the readers for Knip's and
// jscpd's output, the baseline comparison and the summary. The check is warn-only, so what these
// tests guard is that its numbers are right and that a worse number is named rather than lost.
import { describe, expect, it } from "vitest";

import { compareToBaseline, jscpdTotals, knipCounts, renderSummary } from "../scripts/lib/bloat.mjs";

describe("knipCounts", () => {
  it("counts files and each issue category as Knip groups them", () => {
    const counts = knipCounts({
      issues: [
        { file: "a.ts", files: [{ name: "a.ts" }] },
        { file: "b.ts", files: [{ name: "b.ts" }] },
        { file: "x.ts", exports: [{ name: "one" }, { name: "two" }], types: [{ name: "T" }] },
        { file: "package.json", dependencies: [{ name: "left-pad" }], unlisted: [{ name: "zod" }] },
      ],
    });
    expect(counts).toMatchObject({ files: 2, exports: 2, types: 1, dependencies: 1, unlisted: 1, unresolved: 0 });
  });

  it("is all zero for a clean report, so zero means Knip read the project and found nothing", () => {
    expect(Object.values(knipCounts({ issues: [] })).every((n) => n === 0)).toBe(true);
  });
});

describe("jscpdTotals", () => {
  it("takes the totals", () => {
    expect(jscpdTotals({ statistics: { total: { percentage: 1.5, clones: 3, duplicatedLines: 30, lines: 2000, tokens: 1 } } })).toEqual({
      percentage: 1.5,
      clones: 3,
      duplicatedLines: 30,
      lines: 2000,
    });
  });

  it("refuses a report with no totals rather than reading it as zero duplication", () => {
    expect(() => jscpdTotals({})).toThrow("no statistics.total");
  });
});

describe("compareToBaseline", () => {
  const baseline = {
    knip: { files: 2, exports: 5 },
    jscpd: { percentage: 2, clones: 4 },
  };

  it("names each metric that is above the baseline and counts the rest", () => {
    const { worse, notWorse } = compareToBaseline(
      {
        knip: { files: 2, exports: 7 },
        jscpd: { percentage: 1.5, clones: 4 },
      },
      baseline,
    );
    expect(worse).toEqual(["Knip exports: 5 to 7 (+2)"]);
    expect(notWorse).toBe(3);
  });
});

describe("renderSummary", () => {
  const knip = { files: 1, exports: 2 };
  const jscpd = { percentage: 1.25, clones: 3, duplicatedLines: 25, lines: 2000 };

  it("states every number and, against an equal baseline, that nothing is above it", () => {
    const text = renderSummary({ knip, jscpd, baseline: { knip, jscpd } });
    expect(text).toContain("| exports | 2 |");
    expect(text).toContain("3 clones, 25 duplicated lines of 2000 (1.25%)");
    expect(text).toContain("Nothing is above the baseline");
  });

  it("lists what is above the baseline", () => {
    const text = renderSummary({ knip: { files: 4, exports: 2 }, jscpd, baseline: { knip, jscpd } });
    expect(text).toContain("- Knip files: 1 to 4 (+3)");
  });

  it("says when a tool did not run and carries the notes, so a failed tool is not read as a clean one", () => {
    const text = renderSummary({ knip: null, jscpd: null, notes: ["Knip failed: exited 2"] });
    expect(text).toContain("Note: Knip failed: exited 2");
    expect(text).toContain("Knip did not run.");
    expect(text).toContain("jscpd did not run.");
  });
});
