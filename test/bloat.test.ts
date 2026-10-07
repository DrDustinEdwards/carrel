// The logic behind `npm run check:bloat` (scripts/lib/bloat.mjs): the page-weight reader, the
// readers for Knip's and jscpd's output, the baseline comparison and the summary. The check is
// warn-only, so what these tests guard is that its numbers are right and that a worse number is
// named rather than lost.
import { describe, expect, it } from "vitest";

import {
  compareToBaseline,
  jscpdTotals,
  knipCounts,
  pageWeight,
  parseManifest,
  renderSummary,
} from "../scripts/lib/bloat.mjs";

const route = (id: string, parentId: string | undefined, module: string, imports: string[], css: string[], hasDefaultExport = true) => ({
  id,
  parentId,
  path: id === "root" ? "" : id.replace("routes/", ""),
  hasDefaultExport,
  module,
  imports,
  css,
});

// Sizes are the byte length of a stand-in file, and the stand-in gzip is the identity, so the
// expected weights can be added up by hand.
const FILES: Record<string, number> = {
  "/assets/entry.js": 1,
  "/assets/shared.js": 10,
  "/assets/root.js": 100,
  "/assets/frame.js": 1000,
  "/assets/leaf.js": 10000,
  "/assets/api.js": 99999,
  "/assets/root.css": 7,
  "/assets/leaf.css": 70,
};
const read = (file: string) => new Uint8Array(FILES[file] ?? Number.NaN);
const identity = (bytes: Uint8Array) => bytes.length;

const manifest = {
  entry: { module: "/assets/entry.js", imports: ["/assets/shared.js"], css: [] as string[] },
  routes: {
    root: route("root", undefined, "/assets/root.js", ["/assets/shared.js"], ["/assets/root.css"]),
    "routes/frame": route("routes/frame", "root", "/assets/frame.js", [], []),
    "routes/leaf": route("routes/leaf", "routes/frame", "/assets/leaf.js", ["/assets/shared.js"], ["/assets/leaf.css"]),
    "routes/api": route("routes/api", undefined, "/assets/api.js", [], [], false),
  },
};

describe("pageWeight", () => {
  it("adds the entry and every route module from root down, each file once, and leaves out a resource route", () => {
    const weights = pageWeight(manifest, read, identity);
    expect(weights.map((w: { id: string }) => w.id)).toEqual(["root", "routes/frame", "routes/leaf"]);
    const leaf = weights.find((w: { id: string }) => w.id === "routes/leaf");
    // entry 1 + shared 10 (listed by three modules, counted once) + root 100 + frame 1000 + leaf 10000
    expect(leaf.jsGzip).toBe(11111);
    expect(leaf.jsFiles).toBe(5);
    expect(leaf.cssGzip).toBe(77);
    expect(leaf.path).toBe("/frame/leaf");
  });

  it("gives a parent route only its own chain, so a child's files do not leak upward", () => {
    const weights = pageWeight(manifest, read, identity);
    const root = weights.find((w: { id: string }) => w.id === "root");
    expect(root.jsGzip).toBe(111);
    expect(root.cssGzip).toBe(7);
  });

  it("fails loudly on a file the manifest names but the build does not hold", () => {
    expect(() => pageWeight(manifest, () => { throw new Error("ENOENT"); }, identity)).toThrow("ENOENT");
  });
});

describe("parseManifest", () => {
  it("reads the object after the window assignment, with or without a trailing semicolon", () => {
    expect(parseManifest('window.__reactRouterManifest={"a":1};')).toEqual({ a: 1 });
    expect(parseManifest('window.__reactRouterManifest={"a":1}')).toEqual({ a: 1 });
  });

  it("refuses text that is not the manifest", () => {
    expect(() => parseManifest("export default {}")).toThrow("does not start with");
  });
});

describe("knipCounts", () => {
  it("counts files and each issue category as Knip groups them", () => {
    const counts = knipCounts({
      files: ["a.ts", "b.ts"],
      issues: [
        { file: "x.ts", exports: [{ name: "one" }, { name: "two" }], types: [{ name: "T" }] },
        { file: "package.json", dependencies: [{ name: "left-pad" }], unlisted: [{ name: "zod" }] },
      ],
    });
    expect(counts).toMatchObject({ files: 2, exports: 2, types: 1, dependencies: 1, unlisted: 1, unresolved: 0 });
  });

  it("is all zero for a clean report, so zero means Knip read the project and found nothing", () => {
    expect(Object.values(knipCounts({ files: [], issues: [] })).every((n) => n === 0)).toBe(true);
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
    routes: [{ id: "root", jsGzip: 100, cssGzip: 10 }],
  };

  it("names each metric that is above the baseline and counts the rest", () => {
    const { worse, notWorse } = compareToBaseline(
      {
        knip: { files: 2, exports: 7 },
        jscpd: { percentage: 1.5, clones: 4 },
        routes: [{ id: "root", jsGzip: 150, cssGzip: 10 }],
      },
      baseline,
    );
    expect(worse).toEqual(["Knip exports: 5 to 7 (+2)", "route root JS gzip bytes: 100 to 150 (+50)"]);
    expect(notWorse).toBe(4);
  });

  it("names a route the baseline does not have", () => {
    const { worse } = compareToBaseline({ routes: [{ id: "routes/new", jsGzip: 9, cssGzip: 1 }] }, baseline);
    expect(worse).toEqual(["route routes/new: new, 9 B JS and 1 B CSS gzip"]);
  });
});

describe("renderSummary", () => {
  const knip = { files: 1, exports: 2 };
  const jscpd = { percentage: 1.25, clones: 3, duplicatedLines: 25, lines: 2000 };
  const routes = [{ id: "root", jsGzip: 100, cssGzip: 10 }];

  it("states every number and, against an equal baseline, that nothing is above it", () => {
    const text = renderSummary({ knip, jscpd, routes, baseline: { knip, jscpd, routes } });
    expect(text).toContain("| exports | 2 |");
    expect(text).toContain("3 clones, 25 duplicated lines of 2000 (1.25%)");
    expect(text).toContain("| root | 100 | 10 |");
    expect(text).toContain("Nothing is above the baseline");
  });

  it("lists what is above the baseline", () => {
    const text = renderSummary({ knip: { files: 4, exports: 2 }, jscpd, routes, baseline: { knip, jscpd, routes } });
    expect(text).toContain("- Knip files: 1 to 4 (+3)");
  });

  it("says when a tool did not run and carries the notes, so a failed tool is not read as a clean one", () => {
    const text = renderSummary({ knip: null, jscpd: null, routes: null, notes: ["Knip failed: exited 2"] });
    expect(text).toContain("Note: Knip failed: exited 2");
    expect(text).toContain("Knip did not run.");
    expect(text).toContain("jscpd did not run.");
    expect(text).toContain("Page weight did not run.");
  });
});
