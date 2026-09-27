// The voice check's measure (design section 5): sentence length, function-word and punctuation
// profiles of a scene compared with Dustin's own passages in shared/voice/. A distance in the manner
// of Burrows' Delta: each feature's distance from the passages' mean in their standard deviations,
// averaged. It flags only; statistics cannot say whose prose it is, only that it reads unlike his.

const FUNCTION_WORDS = [
  "the", "and", "of", "to", "a", "in", "that", "it", "was", "he", "she", "i", "you", "with", "for", "on", "as",
  "at", "but", "had", "his", "her", "not", "be", "is", "they", "by", "from", "this", "so", "all", "were", "there",
  "which", "would", "when", "then", "what", "if", "into", "out", "up", "like", "just", "some", "no", "one", "or",
];

/** "sentence length", a punctuation mark per 1,000 words, or a quoted function word per 1,000 words. */
type FeatureName = string;

export type Features = Record<FeatureName, number>;

/** How far a passage needs to be before its profile means anything. */
export const MIN_WORDS = 250;
/** The chunk size the baseline passages are cut into, so their spread can be measured. */
const CHUNK_WORDS = 300;
/** The most one feature can add to the distance, in standard deviations. */
const MAX_Z = 5;
/** A floor on sentence length's spread, relative to its mean, so passages that agree closely cannot make it dominate. */
const MIN_SPREAD = 0.15;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}]+(?:['\u2019][\p{L}]+)*/gu) ?? [];
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])["\u201d\u2019)]?\s+(?=["\u201c\u2018(]?[\p{Lu}\d])/u)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

function per1000(count: number, total: number): number {
  return total === 0 ? 0 : (count * 1000) / total;
}

export function features(text: string): Features {
  const all = words(text);
  const total = all.length;
  const sents = sentences(text);
  const counts = new Map<string, number>();
  for (const w of all) counts.set(w, (counts.get(w) ?? 0) + 1);
  const count = (re: RegExp) => text.match(re)?.length ?? 0;

  const out = {
    "sentence length": sents.length === 0 ? 0 : total / sents.length,
    commas: per1000(count(/,/g), total),
    semicolons: per1000(count(/;/g), total),
    colons: per1000(count(/:/g), total),
    dashes: per1000(count(/\u2014|\u2013|--/g), total),
    questions: per1000(count(/\?/g), total),
    exclamations: per1000(count(/!/g), total),
  } as Features;
  for (const fw of FUNCTION_WORDS) out[`"${fw}"`] = per1000(counts.get(fw) ?? 0, total);
  return out;
}

export type Profile = { mean: Features; spread: Features; chunks: number; words: number };

/** Cuts text into runs of about CHUNK_WORDS words, on paragraph boundaries where it can. */
function chunks(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    current.push(p);
    size += words(p).length;
    if (size >= CHUNK_WORDS) {
      out.push(current.join("\n\n"));
      current = [];
      size = 0;
    }
  }
  if (size >= CHUNK_WORDS / 2) out.push(current.join("\n\n"));
  return out;
}

/** The profile of Dustin's passages, or null when there is too little of his text to compare with. */
export function profileOf(passages: string[]): Profile | null {
  const pieces = passages.flatMap(chunks);
  if (pieces.length < 3) return null;
  const rows = pieces.map(features);
  const names = Object.keys(rows[0]!) as FeatureName[];
  const mean = {} as Features;
  const spread = {} as Features;
  for (const name of names) {
    const values = rows.map((r) => r[name] ?? 0);
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
    mean[name] = m;
    // A spread of zero would make any difference infinitely far. A rate cannot be measured finer
    // than one occurrence in a chunk, so that is its floor; sentence length gets a relative one.
    const floor = name === "sentence length" ? MIN_SPREAD * Math.max(1, m) : 1000 / CHUNK_WORDS;
    spread[name] = Math.max(Math.sqrt(variance), floor);
  }
  return { mean, spread, chunks: pieces.length, words: passages.reduce((n, p) => n + words(p).length, 0) };
}

export type VoiceReading = {
  distance: number;
  /** The features furthest from the passages, with the scene's value and the passages' mean. */
  furthest: { name: FeatureName; value: number; mean: number; z: number }[];
};

export function distanceFrom(profile: Profile, text: string): VoiceReading | null {
  if (words(text).length < MIN_WORDS) return null;
  const f = features(text);
  const scored = Object.keys(profile.mean).map((name) => {
    const value = f[name] ?? 0;
    const mean = profile.mean[name] ?? 0;
    return { name, value, mean, z: (value - mean) / (profile.spread[name] ?? 1) };
  });
  // Each feature counts for at most MAX_Z, so one habit (a single semicolon where the passages have
  // none) cannot outweigh everything else.
  const distance = scored.reduce((a, s) => a + Math.min(MAX_Z, Math.abs(s.z)), 0) / scored.length;
  const furthest = [...scored].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3);
  return { distance, furthest };
}

/**
 * Where a scene counts as reading unlike the passages. Set between the fixtures in test/voice.test.ts
 * (measured 2026-09-27: the baseline's own passages 0.45 to 0.54, the same register not in the
 * baseline 0.76, a public-domain passage by Henry James 1.49). Recalibrate once shared/voice/ holds
 * Dustin's own text: the test fixtures stand in for it.
 */
export const VOICE_THRESHOLD = 1.1;

export function describeFeature(f: VoiceReading["furthest"][number]): string {
  const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
  if (f.name === "sentence length") return `sentences average ${round(f.value)} words against ${round(f.mean)} in your passages`;
  return `${round(f.value)} ${f.name} per 1,000 words against ${round(f.mean)}`;
}
