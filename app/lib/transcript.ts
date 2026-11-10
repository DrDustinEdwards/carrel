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

/** One cue as written: its timing line exactly, and its text lines joined. */
type WrittenCue = { timing: string; start: number; text: string };

const TIMING = /^((\d{2,}):)?(\d{2}):(\d{2})\.(\d{3}) --> \S+/;

function writtenCues(vtt: string): WrittenCue[] {
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  const cues: WrittenCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TIMING.exec(lines[i]!.trim());
    if (!m) continue;
    const text: string[] = [];
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") text.push(lines[++i]!.trim());
    cues.push({
      timing: lines[i - text.length]!.trim(),
      start: +(m[2] ?? 0) * 3600 + +m[3]! * 60 + +m[4]!,
      text: text.join(" "),
    });
  }
  return cues;
}

type TranscriptChange = { cue: number; at: number; before: string; after: string };

/** The most changed cues a summary lists; the counts cover them all. */
const LISTED = 200;

/**
 * What a transcript draft changes against the site's transcript, cue by cue in order: the cues whose words changed
 * (the first LISTED), and how many cues were added, removed or moved in time. A fix of misheard words changes text only;
 * a retimed cue moves the chapters and key moments that point at it, so a reader is told.
 */
export function transcriptChanges(before: string, after: string) {
  const a = writtenCues(before);
  const b = writtenCues(after);
  const changed: TranscriptChange[] = [];
  let textChanged = 0;
  let retimed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]!.timing !== b[i]!.timing) retimed++;
    if (a[i]!.text !== b[i]!.text) {
      textChanged++;
      if (changed.length < LISTED)
        changed.push({ cue: i + 1, at: b[i]!.start, before: a[i]!.text, after: b[i]!.text });
    }
  }
  return {
    cues: b.length,
    textChanged,
    changed,
    retimed,
    added: Math.max(0, b.length - a.length),
    removed: Math.max(0, a.length - b.length),
  };
}

/** Why a text is not a transcript the site takes, or null: WebVTT, the WEBVTT line first and at least one cue. */
export function transcriptRefusal(vtt: string): string | null {
  if (!/^\uFEFF?WEBVTT(?:[ \t][^\n]*)?\r?\n/.test(vtt))
    return "A transcript is WebVTT: it starts with the line WEBVTT.";
  if (writtenCues(vtt).length === 0) return "The transcript has no cues.";
  return null;
}

/**
 * The site's transcript with each edit applied in order, every occurrence of its `find` replaced. An edit whose
 * `find` is not in the text by then is refused by name, so a fix never silently does nothing.
 */
export function applyTranscriptEdits(
  vtt: string,
  edits: { find: string; replace: string }[],
): { ok: true; transcript: string; replaced: number[] } | { ok: false; why: string } {
  let text = vtt;
  const replaced: number[] = [];
  for (const { find, replace } of edits) {
    if (!find) return { ok: false, why: "An edit has an empty find." };
    const parts = text.split(find);
    if (parts.length === 1)
      return { ok: false, why: `"${find}" is not in the transcript (after the edits before it).` };
    replaced.push(parts.length - 1);
    text = parts.join(replace);
  }
  return { ok: true, transcript: text, replaced };
}
