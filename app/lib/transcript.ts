// A WebVTT transcript as the model reads it, and the placing of the chapters it gives back. The model never writes a time:
// asked for seconds it gave times past the end of the episode, and when it chose from time markers it drifted up to a
// minute late. It quotes the words a chapter opens with, and the time is the start of the cue that says them.

const CUE = /(\d{2}):(\d{2}):(\d{2})\.\d{3} --> (\d{2}):(\d{2}):(\d{2})\.\d{3}/;

type Cue = { start: number; text: string };
type ParsedTranscript = { text: string; duration: number; cues: Cue[] };

/** The transcript's cues as running text, with each cue's start in seconds. */
export function parseTranscript(vtt: string): ParsedTranscript {
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  const cues: Cue[] = [];
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = CUE.exec(lines[i]!);
    if (!m) continue;
    const start = +m[1]! * 3600 + +m[2]! * 60 + +m[3]!;
    duration = Math.max(duration, +m[4]! * 3600 + +m[5]! * 60 + +m[6]!);
    const text: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") text.push(lines[++i]!.trim());
    cues.push({ start, text: text.join(" ") });
  }
  return { text: cues.map((c) => c.text).join(" "), duration, cues };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The fewest words a quote needs to point at one place. */
const MIN_WORDS = 3;

/**
 * Each chapter put at the cue where its opening words are said, searching forward from the chapter before, so a phrase
 * said twice lands at the right one. A quote the transcript does not have, or chapters out of order, is refused with the
 * reason: nothing is saved rather than a time that points at the wrong place.
 */
export function placeChapters(
  chapters: { opens: string; title: string }[],
  transcript: ParsedTranscript,
): { ok: true; chapters: { start: number; title: string }[] } | { ok: false; why: string } {
  // One normalized string, and where each cue begins in it.
  let flat = " ";
  const offsets = transcript.cues.map((c) => {
    const at = flat.length;
    flat += `${words(c.text)} `;
    return at;
  });
  const kept: { start: number; title: string }[] = [];
  let from = 0;
  for (const c of chapters) {
    const title = c.title.trim();
    const quote = words(c.opens);
    if (!title || quote.split(" ").length < MIN_WORDS)
      return {
        ok: false,
        why: `a chapter has no title or too short an opening quote (${JSON.stringify(c)})`,
      };
    const hit = flat.indexOf(` ${quote} `, from);
    if (hit < 0)
      return {
        ok: false,
        why: `"${title}": the opening words "${c.opens}" are not in the transcript after the chapter before`,
      };
    let cue = 0;
    while (cue + 1 < offsets.length && offsets[cue + 1]! <= hit + 1) cue++;
    from = hit + 1;
    const start = transcript.cues[cue]!.start;
    if (!kept.some((k) => k.start === start)) kept.push({ start, title });
  }
  return kept.length >= 3
    ? { ok: true, chapters: kept }
    : { ok: false, why: `only ${kept.length} chapters were left` };
}

/**
 * What is wrong with an episode source's keyMoments against its transcript: a moment's `seconds` must be the start of a
 * cue, within the episode. Cue numbers written as seconds (cue 56 is not 0:56) put every moment at the wrong place.
 */
export function keyMomentProblems(source: string, vtt: string): string[] {
  const raw = /^keyMoments:\s*(.*)$/m
    .exec(/^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "")?.[1]
    ?.trim();
  if (!raw || raw === "[]") return [];
  let moments: unknown;
  try {
    moments = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(moments)) return [];
  const { cues, duration } = parseTranscript(vtt);
  if (!cues.length) return [];
  const starts = new Set(cues.map((c) => c.start));
  const problems: string[] = [];
  for (const m of moments as { seconds?: unknown; label?: unknown }[]) {
    const at = m?.seconds;
    const label = typeof m?.label === "string" ? m.label : "";
    if (typeof at !== "number" || at > duration)
      problems.push(`"${label}": ${String(at)} s is not inside the ${duration} s episode.`);
    else if (!starts.has(at))
      problems.push(
        `"${label}": ${at} s is not where any transcript cue starts. keyMoments seconds are real seconds, not cue numbers.`,
      );
  }
  return problems;
}
