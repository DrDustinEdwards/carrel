// Planted problems for the checks on save (design section 7): each check must flag its plant and stay
// quiet on the clean twin beside it. The checks are pure, so these run without Git or D1.

import { describe, expect, it } from "vitest";

import {
  checkAiHabits,
  dashesFor,
  checkContinuity,
  checkFile,
  checkRuleFile,
  checkTimeline,
  checkVoice,
  checkWorldRules,
  readHabits,
  storyDate,
  type Bible,
  type BookContext,
} from "~/lib/novels/checks";
import { parseFile } from "~/lib/novels/frontmatter";
import { readMeta, type SceneHeader } from "~/lib/novels/layout";
import { profileOf } from "@dustinedwards/site-runtime/prose";

import { BASELINE, PLANT, TWIN } from "./fixtures/voice";

const BIBLE: Bible = {
  characters: [
    { name: "Wade Pruitt", aliases: ["Wade"], born: "1996-02-11", died: "" },
    { name: "June Harlan", aliases: ["Mrs. Harlan"], born: "1931-05-02", died: "2019-08-30" },
    { name: "Nell", aliases: [], born: "2031-01-01", died: "" },
  ],
  places: [{ name: "Harlan place", aliases: ["the farm"] }, { name: "Paluxy crossing", aliases: [] }],
  rules: [{ name: "No phones past the ridge", forbidden: ["\\bphone rang\\b", "text(?:ed)? (?:her|him|me)"] }],
};

function scene(header: Partial<Record<keyof SceneHeader, string | string[] | boolean>>, body = "Plain prose.\n"): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(header)) lines.push(`${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : String(v)}`);
  lines.push("---", "", body);
  return lines.join("\n");
}

function headerOf(path: string, source: string): SceneHeader {
  const meta = readMeta(path, parseFile(source).data, true);
  if (meta.kind !== "scene") throw new Error("not a scene");
  return meta.header;
}

const FULL = { pov: "Wade", date: "2024-04-12", location: "Harlan place", characters: ["Wade"], goal: "g", conflict: "c", outcome: "o" };

describe("PLANT: continuity", () => {
  const path = "chapters/01-arrival/01-the-gate.md";
  const run = (source: string) => checkContinuity(path, source, headerOf(path, source), BIBLE);

  it("flags a character not in the bible", () => {
    const found = run(scene({ ...FULL, characters: ["Wade", "Tobias"] }));
    expect(found.map((f) => f.message)).toEqual(["Tobias is in this scene but not in the bible (bible/characters/)."]);
    expect(found[0]!.line).toBe(5);
  });

  it("flags a dead character present, found by alias", () => {
    const found = run(scene({ ...FULL, characters: ["Wade", "Mrs. Harlan"] }));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toBe("June Harlan died 2019-08-30, before this scene (2024-04-12), and is present in it.");
  });

  it("flags a character not born yet, and a location not in the bible", () => {
    const found = run(scene({ ...FULL, characters: ["Nell"], location: "Glen Rose" }));
    expect(found.map((f) => f.check)).toEqual(["continuity", "continuity"]);
    expect(found[0]!.message).toContain("Nell is born 2031-01-01, after this scene");
    expect(found[1]!.message).toBe('The location "Glen Rose" is not in the bible (bible/places/).');
  });

  it("CLEAN TWIN: everyone known and alive, the place known by alias: nothing", () => {
    expect(run(scene({ ...FULL, characters: ["Wade", "Mrs. Harlan"], date: "2012-06-01", location: "the farm" }))).toEqual([]);
  });
});

describe("PLANT: timeline", () => {
  const scenes = [
    { path: "chapters/01-arrival/01-the-gate.md", header: headerOf("chapters/01-a/01-b.md", scene({ ...FULL, date: "2024-04-12" })) },
    { path: "chapters/01-arrival/02-supper.md", header: headerOf("chapters/01-a/01-b.md", scene({ ...FULL, date: "2024-04-12 19:00" })) },
    { path: "chapters/02-letters/01-morning.md", header: headerOf("chapters/01-a/01-b.md", scene({ ...FULL, date: "2024-04-13" })) },
  ].map((s) => ({ ...s, header: { ...s.header } }));
  const path = "chapters/02-letters/02-the-letter.md";

  it("flags a scene dated before the one it follows, with no flashback mark", () => {
    const source = scene({ ...FULL, date: "2024-04-12 08:00" });
    const found = checkTimeline(path, source, headerOf(path, source), scenes);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toBe(
      "Dated 2024-04-12 08:00, before the scene it follows (chapters/02-letters/01-morning.md, 2024-04-13), and not marked flashback: true.",
    );
  });

  it("CLEAN TWIN: the same scene marked flashback: true is not flagged", () => {
    const source = scene({ ...FULL, date: "2024-04-12 08:00", flashback: true });
    expect(checkTimeline(path, source, headerOf(path, source), scenes)).toEqual([]);
  });

  it("CLEAN TWIN: a scene in order is not flagged, and a flashback before it does not move the clock", () => {
    const withFlashback = [...scenes, { path: "chapters/02-letters/02-summer-1990.md", header: { ...scenes[0]!.header, date: "1990-07-01", flashback: true } }];
    const next = "chapters/02-letters/03-noon.md";
    const source = scene({ ...FULL, date: "2024-04-13 12:00" });
    expect(checkTimeline(next, source, headerOf(next, source), withFlashback)).toEqual([]);
  });

  it("orders chapter 100 after chapter 99", () => {
    const late = [{ path: "chapters/99-late/01-a.md", header: { ...scenes[0]!.header, date: "2030-01-01" } }];
    const p = "chapters/100-later/01-b.md";
    const source = scene({ ...FULL, date: "2029-01-01" });
    expect(checkTimeline(p, source, headerOf(p, source), late)).toHaveLength(1);
  });

  it("reads story dates strictly", () => {
    expect(storyDate("2024-04-12")).toBe("2024-04-12T00:00");
    expect(storyDate("2024-04-12 19:05")).toBe("2024-04-12T19:05");
    expect(storyDate("April 12")).toBeNull();
    expect(storyDate("2024-13-01")).toBeNull();
  });
});

describe("PLANT: world rules", () => {
  const path = "chapters/01-arrival/01-the-gate.md";

  it("flags a forbidden pattern from a rule, on the file's own line", () => {
    const source = scene(FULL, "The road was quiet.\n\nThen the phone rang in his pocket.\n");
    const found = checkWorldRules(path, source, BIBLE.rules);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "world-rules", line: 13, excerpt: "phone rang" });
    expect(found[0]!.message).toBe('Breaks the rule "No phones past the ridge" (forbidden: \\bphone rang\\b).');
  });

  it("CLEAN TWIN: prose that keeps the rule is not flagged", () => {
    expect(checkWorldRules(path, scene(FULL, "He had no signal, and the phone stayed dark.\n"), BIBLE.rules)).toEqual([]);
  });

  it("flags a rule whose pattern cannot compile, on the rule's own file", () => {
    const found = checkRuleFile("bible/rules/phones.md", "---\nname: Phones\nforbidden: [\"(unclosed\"]\n---\n", { name: "Phones", forbidden: ["(unclosed"] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "bible/rules/phones.md", line: 3, excerpt: "(unclosed" });
  });
});

// The habits themselves are site-runtime ./prose's, tested there. These hold the wiring: Dustin's list,
// his allow list, conditions: false, dashes decided by his passages, and the file's own line numbers.
describe("PLANT: AI habits", () => {
  const path = "chapters/01-arrival/01-the-gate.md";
  const habits = readHabits(null);
  const run = (body: string) => checkAiHabits(path, scene(FULL, body), habits);

  it("flags a seed word and a construction on the file's own line", () => {
    expect(run("She stood a while.\nIt's not just a house, it's a promise.\n")).toMatchObject([{ check: "ai-habits", line: 12 }]);
    expect(run("The journey north took a day.\n")).toMatchObject([{ check: "ai-habits", excerpt: "journey", line: 11 }]);
  });

  it("CLEAN TWIN: the same ideas without the habits are not flagged", () => {
    expect(run("It's not raining, so we walked.\n\nIt was a house. He meant it as a promise.\n")).toEqual([]);
  });

  it("takes words from shared/checks/ai-habits.md, lets Dustin allow one back, and turns the constructions off", () => {
    const custom = readHabits("---\nwords: [suddenly]\nallow: [journey, discover]\n---\n");
    expect(checkAiHabits(path, scene(FULL, "Suddenly the journey was over.\n"), custom).map((f) => f.excerpt)).toEqual(["Suddenly"]);
    const words = readHabits("---\nconditions: false\n---\n");
    expect(checkAiHabits(path, scene(FULL, "It's not just a house, it's a promise.\n"), words)).toEqual([]);
  });

  it("flags dashes unless Dustin's passages use them, or the file says", () => {
    const body = "We left early \u2014 the road was out.\n";
    expect(run(body).map((f) => f.message)).toEqual(["A dash where a comma, a full stop or brackets would do."]);
    const dashed = profileOf(BASELINE.map((p) => p.replace(/\. /g, " \u2014 ")));
    expect(dashesFor(habits, dashed)).toBe("allow");
    expect(checkAiHabits(path, scene(FULL, body), habits, dashed)).toEqual([]);
    expect(dashesFor(readHabits("---\ndashes: flag\n---\n"), dashed)).toBe("flag");
  });
});

describe("PLANT: voice", () => {
  const profile = profileOf(BASELINE);
  const path = "chapters/01-arrival/01-the-gate.md";

  it("flags a public-domain passage by another author among Dustin's", () => {
    const found = checkVoice(path, scene(FULL, PLANT), profile);
    expect(found).toHaveLength(1);
    expect(found[0]!.check).toBe("voice");
    expect(found[0]!.message).toMatch(/^Reads unlike your passages in shared\/voice\/ \(distance \d\.\d\d, flagged from 1\.1\): sentences average/);
  });

  it("CLEAN TWIN: more of Dustin's register, not in the passages, is not flagged", () => {
    expect(checkVoice(path, scene(FULL, TWIN), profile)).toEqual([]);
  });

  it("stays silent without passages to compare with, or on a short scene", () => {
    expect(checkVoice(path, scene(FULL, PLANT), null)).toEqual([]);
    expect(profileOf([BASELINE[0]!.slice(0, 400)])).toBeNull();
    expect(checkVoice(path, scene(FULL, PLANT.slice(0, 600)), profile)).toEqual([]);
  });
});

describe("the header and checkFile", () => {
  const context: BookContext = { bible: BIBLE, scenes: [], habits: readHabits(null), voice: null };

  it("PLANT: a scene with no header is flagged, and so is a missing field", () => {
    expect(checkFile("chapters/01-a/01-b.md", "Just prose.\n", context).map((f) => f.check)).toContain("header");
    const found = checkFile("chapters/01-a/01-b.md", scene({ ...FULL, location: "", outcome: "" }), context);
    expect(found.map((f) => f.message)).toEqual(["The header has no location.", "The beats have no outcome yet."]);
  });

});
