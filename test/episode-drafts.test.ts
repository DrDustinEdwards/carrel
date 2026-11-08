// Which episodes get drafted (an empty summary or chapters), that a chapter time is one the transcript has (the model once gave
// times past the end of the episode), and that a claim left by a pass that died is freed.
import { beforeEach, describe, expect, it } from "vitest";

import { freeDeadClaim, needsDraft } from "~/lib/episode-drafts.server";
import { d1FireStore } from "~/lib/social/routine.server";
import { checkedChapters, markTranscript } from "~/lib/transcript";

import { resetDb, testEnv } from "./env";

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

const cue = (n: number, from: number, to: number, text: string) =>
  `${n}\n00:${String(Math.floor(from / 60)).padStart(2, "0")}:${String(from % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor(to / 60)).padStart(2, "0")}:${String(to % 60).padStart(2, "0")}.000\n${text}\n`;
const vtt = `WEBVTT\n\n${[cue(1, 0, 20, "Hello."), cue(2, 35, 50, "Soup."), cue(3, 70, 95, "Bread."), cue(4, 100, 125, "Done.")].join("\n")}`;

describe("chapter times", () => {
  it("snap to the transcript's markers, and a time the transcript lacks is refused with its reason", () => {
    const t = markTranscript(vtt);
    expect(t.marks).toEqual([0, 35, 70, 100]);
    expect(t.duration).toBe(125);
    const ch = (...starts: number[]) => starts.map((start, i) => ({ start, title: `T${i}` }));
    const ok = checkedChapters(ch(0, 40, 100), t);
    expect(ok.ok && ok.chapters.map((c) => c.start)).toEqual([0, 35, 100]);
    const past = checkedChapters(ch(0, 35, 3550), t);
    expect(!past.ok && past.why).toContain("past the end");
    expect(checkedChapters(ch(0, 35), t).ok).toBe(false);
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
