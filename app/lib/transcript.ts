// A WebVTT transcript as the model reads it, and a check of the chapter times it gives back. The model is shown the text
// with a [m:ss] marker every half minute and may only start a chapter at a marker, so a time cannot be made up: asked for
// seconds from raw cues, it gave times past the end of the episode.

const CUE = /(\d{2}):(\d{2}):(\d{2})\.\d{3} --> (\d{2}):(\d{2}):(\d{2})\.\d{3}/;
/** Seconds between markers. */
const MARK_EVERY = 30;
/** How far a returned time may sit from a marker before it is not trusted. */
const SNAP = 10;

export type MarkedTranscript = { text: string; duration: number; marks: number[] };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The transcript's cues as running text, a `[m:ss]` marker at the start and then at the first cue after every half minute. */
export function markTranscript(vtt: string): MarkedTranscript {
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  const marks: number[] = [];
  const out: string[] = [];
  let duration = 0;
  let last = -MARK_EVERY;
  for (let i = 0; i < lines.length; i++) {
    const m = CUE.exec(lines[i]!);
    if (!m) continue;
    const start = +m[1]! * 3600 + +m[2]! * 60 + +m[3]!;
    duration = Math.max(duration, +m[4]! * 3600 + +m[5]! * 60 + +m[6]!);
    const text: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") text.push(lines[++i]!.trim());
    if (start - last >= MARK_EVERY) {
      last = start;
      marks.push(start);
      out.push(`\n[${clock(start)}]`);
    }
    out.push(text.join(" "));
  }
  return { text: out.join(" ").trim(), duration, marks };
}

/**
 * The chapters whose start sits at a marker (within SNAP seconds), moved onto it, in time order and one to a time. Null
 * when fewer than three survive or any was dropped for a time the transcript does not have: the caller then leaves the
 * chapters out rather than save times that point nowhere.
 */
export function checkedChapters(
  chapters: { start: number; title: string }[],
  transcript: MarkedTranscript,
): { start: number; title: string }[] | null {
  const kept: { start: number; title: string }[] = [];
  for (const c of chapters) {
    const title = c.title.trim();
    if (!Number.isInteger(c.start) || c.start < 0 || !title) return null;
    const near = transcript.marks.reduce(
      (a, b) => (Math.abs(b - c.start) < Math.abs(a - c.start) ? b : a),
      -1e9,
    );
    if (Math.abs(near - c.start) > SNAP || kept.some((k) => k.start === near)) return null;
    kept.push({ start: near, title });
  }
  kept.sort((a, b) => a.start - b.start);
  return kept.length >= 3 ? kept : null;
}
