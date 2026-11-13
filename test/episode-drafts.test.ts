// Which episodes get drafted (an empty summary or chapters), that a chapter's time is the cue that says its opening words (the model once gave
// times past the end of the episode, and later drifted a minute late), and that a claim left by a pass that died is freed.
import { beforeEach, describe, expect, it } from "vitest";

import { unwrittenNames } from "~/lib/ai-engine.server";
import { freeDeadClaim, needsDraft } from "~/lib/episode-drafts.server";
import { d1FireStore } from "~/lib/social/routine.server";
import { keyMomentProblems, parseTranscript, placeChapters } from "~/lib/transcript";

import { resetDb, testEnv } from "./env";

const source = (excerpt: string, chapters: string) =>
  `---\ntitle: "Pump"\nexcerpt: ${excerpt}\nchapters: ${chapters}\n---\nBody`;

describe("needsDraft", () => {
  it("is true when the summary or the chapters are empty or missing, false when both are filled", () => {
    expect(needsDraft(source('""', '[{"start":0,"title":"A"}]'))).toBe(true);
    expect(needsDraft(source('"A summary."', "[]"))).toBe(true);
    expect(needsDraft('---\ntitle: "Pump"\n---\nBody')).toBe(true);
    expect(needsDraft(source('"A summary."', '[{"start":0,"title":"A"}]'))).toBe(false);
  });
});

const cue = (n: number, from: number, to: number, text: string) => {
  const t = (s: number) =>
    `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
  return `${n}\n${t(from)} --> ${t(to)}\n${text}\n`;
};
const vtt = `WEBVTT\n\n${[
  cue(1, 0, 20, "Welcome to the show, everyone."),
  cue(2, 35, 50, "Now the soup, which is hot."),
  cue(3, 70, 95, "Then the bread, which is not."),
  cue(4, 100, 125, "Now the soup, again, and done."),
].join("\n")}`;

describe("chapter times", () => {
  it("come from the cue that says the opening words, searching forward, and a quote the transcript lacks is refused", () => {
    const t = parseTranscript(vtt);
    expect(t.duration).toBe(125);
    const ch = (...opens: string[]) => opens.map((o, i) => ({ opens: o, title: `T${i}` }));
    const ok = placeChapters(ch("welcome to the show", "Now the soup, which", "then the bread"), t);
    expect(ok.ok && ok.chapters.map((c) => c.start)).toEqual([0, 35, 70]);
    const again = placeChapters(
      ch("welcome to the show", "then the bread", "now the soup again"),
      t,
    );
    expect(again.ok && again.chapters.map((c) => c.start)).toEqual([0, 70, 100]);
    const missing = placeChapters(
      ch("welcome to the show", "now the soup", "a line nobody said"),
      t,
    );
    expect(!missing.ok && missing.why).toContain("not in the transcript");
    expect(placeChapters(ch("welcome to the show", "now the soup"), t).ok).toBe(false);
    // A name the episode's own text never spells is sent back: "Gina Geis" for Jeanna Giese.
    const drafted = {
      excerpt: "The hosts cover Pasteur.",
      chapters: [
        { title: "Gina Geis and the Milwaukee Protocol" },
        { title: "Dustin's rabies scare" },
      ],
    };
    expect(unwrittenNames(drafted, "Jeanna Giese survived in Milwaukee. Pasteur. Dustin.")).toEqual(
      ["Geis", "Protocol"],
    );
    // Key moments follow the same rule: a time is a cue's start, and a cue number written as seconds is flagged.
    const front = (m: string) => `---\ntitle: "Pump"\nkeyMoments: ${m}\n---\nBody`;
    expect(keyMomentProblems(front('[{"seconds":35,"label":"Soup"}]'), vtt)).toEqual([]);
    expect(keyMomentProblems(front('[{"seconds":3,"label":"Soup"}]'), vtt)).toHaveLength(1);
    expect(keyMomentProblems(front('[{"seconds":400,"label":"Late"}]'), vtt)).toHaveLength(1);
  });
});

describe("a claim left by a pass that died", () => {
  beforeEach(resetDb);
  it("is freed once it is older than the lease and no API draft was saved since", async () => {
    const store = d1FireStore(testEnv.DB);
    const now = new Date("2026-11-08T12:00:00Z");
    await store.add("api-episode-draft:x:10", "2026-11-08T11:00:00.000Z");
    await store.add("api-episode-draft:y:10", "2026-11-08T11:59:00.000Z");
    await freeDeadClaim(testEnv.DB, store, "api-episode-draft:x:10", "x", now);
    await freeDeadClaim(testEnv.DB, store, "api-episode-draft:y:10", "y", now);
    expect(await store.get("api-episode-draft:x:10")).toBeNull();
    expect(await store.get("api-episode-draft:y:10")).not.toBeNull();
  });
});
