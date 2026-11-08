// A chapter time must be one the transcript has: the model once gave times past the end of the episode.
import { describe, expect, it } from "vitest";

import { checkedChapters, markTranscript } from "~/lib/transcript";

const cue = (n: number, from: number, to: number, text: string) =>
  `${n}\n00:${String(Math.floor(from / 60)).padStart(2, "0")}:${String(from % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor(to / 60)).padStart(2, "0")}:${String(to % 60).padStart(2, "0")}.000\n${text}\n`;
const vtt = `WEBVTT\n\n${[cue(1, 0, 20, "Hello."), cue(2, 35, 50, "Soup."), cue(3, 70, 95, "Bread."), cue(4, 100, 125, "Done.")].join("\n")}`;

describe("transcripts", () => {
  it("marks every half minute and measures the episode", () => {
    const t = markTranscript(vtt);
    expect(t.marks).toEqual([0, 35, 70, 100]);
    expect(t.duration).toBe(125);
    expect(t.text).toContain("[1:10] Bread.");
  });
  it("snaps a chapter onto a marker and refuses times the transcript lacks", () => {
    const t = markTranscript(vtt);
    const ch = (...starts: number[]) => starts.map((start, i) => ({ start, title: `T${i}` }));
    expect(checkedChapters(ch(0, 38, 100), t)?.map((c) => c.start)).toEqual([0, 35, 100]);
    expect(checkedChapters(ch(0, 35, 3550), t)).toBeNull();
    expect(checkedChapters(ch(0, 35), t)).toBeNull();
  });
});
