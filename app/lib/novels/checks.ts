// The checks on save (design section 5): deterministic, inside the app, and for catching errors
// early, never for deciding. Each takes a file and the book's context and returns findings; none
// refuses anything. A finding names the file's own line, so the editor can point at it.

import { list, parseFile } from "./frontmatter";
import {
  kindOf,
  readMeta,
  readingOrder,
  type CharacterEntry,
  type Meta,
  type PlaceEntry,
  type RuleEntry,
  type SceneHeader,
} from "./layout";
import { describeFeature, distanceFrom, VOICE_THRESHOLD, type Profile } from "./voice";

export type CheckName = "header" | "continuity" | "timeline" | "world-rules" | "ai-habits" | "voice";

export type Finding = {
  path: string;
  check: CheckName;
  message: string;
  line: number | null;
  excerpt: string | null;
};

export type Bible = { characters: CharacterEntry[]; places: PlaceEntry[]; rules: RuleEntry[] };

export type SceneRow = { path: string; header: SceneHeader };

export type AiHabits = { words: string[]; conditions: boolean };

export type BookContext = {
  bible: Bible;
  /** Every scene's header, as the index holds it. The file being checked replaces its own row. */
  scenes: SceneRow[];
  habits: AiHabits;
  voice: Profile | null;
};

/**
 * The AI-tells list in capsid/conventions.md (Writing style, 2026-09-25), as the seed. Dustin adds
 * words or allows one back in shared/checks/ai-habits.md. In fiction several of these are ordinary
 * words, which is why a hit is a flag for him to weigh, not a rule.
 */
export const SEED_WORDS = [
  "delve", "tapestry", "spans", "landscape", "realm", "navigate", "testament to", "boasts", "stands as",
  "compelling", "must-read", "journey", "explore", "dive into", "discover", "it's worth noting",
  "importantly", "furthermore",
];

/** shared/checks/ai-habits.md: `words:` adds to the seed, `allow:` removes, `conditions: false` turns the patterns off. */
export function readHabits(source: string | null): AiHabits {
  if (source === null) return { words: SEED_WORDS, conditions: true };
  const { data } = parseFile(source);
  const allow = new Set(list(data, "allow").map((w) => w.toLowerCase()));
  const words = [...SEED_WORDS, ...list(data, "words")].map((w) => w.toLowerCase()).filter((w) => !allow.has(w));
  return { words: [...new Set(words)], conditions: data.conditions !== false };
}

// ---------- helpers

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

/** A story date, normalised so two compare as strings; null when it is not one. */
export function storyDate(value: string): string | null {
  const m = DATE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}T${h ?? "00"}:${mi ?? "00"}`;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findCharacter(bible: Bible, name: string): CharacterEntry | undefined {
  return bible.characters.find((c) => sameName(c.name, name) || c.aliases.some((a) => sameName(a, name)));
}

function findPlace(bible: Bible, name: string): PlaceEntry | undefined {
  return bible.places.find((p) => sameName(p.name, name) || p.aliases.some((a) => sameName(a, name)));
}

/** The line in the file where the header key sits, for a finding about it. */
function headerLine(source: string, key: string): number | null {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  return i === -1 ? null : i + 1;
}

/** Every match of `re` in the body, with the file line it falls on. */
function matchesIn(body: string, bodyLine: number, re: RegExp): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(re)) out.push({ line: bodyLine + i, text: m[0] });
  });
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------- the checks

/** The header is where the other checks get their facts; a missing field makes them silent, so it is flagged. */
export function checkHeader(path: string, source: string, header: SceneHeader, hasHeader: boolean): Finding[] {
  if (!hasHeader) {
    return [{ path, check: "header", message: "This scene has no header, so the continuity and timeline checks cannot run.", line: 1, excerpt: null }];
  }
  const out: Finding[] = [];
  for (const key of ["pov", "date", "location"] as const) {
    if (!header[key]) out.push({ path, check: "header", message: `The header has no ${key}.`, line: headerLine(source, key) ?? 1, excerpt: null });
  }
  for (const key of ["goal", "conflict", "outcome"] as const) {
    if (!header[key]) out.push({ path, check: "header", message: `The beats have no ${key} yet.`, line: headerLine(source, key) ?? 1, excerpt: null });
  }
  if (header.date && !storyDate(header.date)) {
    out.push({
      path,
      check: "header",
      message: `The date "${header.date}" is not a story date; write it as 2031-04-12 or 2031-04-12 14:30.`,
      line: headerLine(source, "date"),
      excerpt: header.date,
    });
  }
  return out;
}

/** Continuity: everyone present is in the bible and alive (and born) at the scene's date; the location exists. */
export function checkContinuity(path: string, source: string, header: SceneHeader, bible: Bible): Finding[] {
  const out: Finding[] = [];
  const date = storyDate(header.date);
  const present = [...new Set([header.pov, ...header.characters].filter(Boolean))];
  for (const name of present) {
    const key = name === header.pov && !header.characters.includes(name) ? "pov" : "characters";
    const character = findCharacter(bible, name);
    if (!character) {
      out.push({ path, check: "continuity", message: `${name} is in this scene but not in the bible (bible/characters/).`, line: headerLine(source, key), excerpt: name });
      continue;
    }
    const died = storyDate(character.died);
    const born = storyDate(character.born);
    if (date && died && died < date) {
      out.push({
        path,
        check: "continuity",
        message: `${character.name} died ${character.died}, before this scene (${header.date}), and is present in it.`,
        line: headerLine(source, key),
        excerpt: name,
      });
    }
    if (date && born && born > date) {
      out.push({
        path,
        check: "continuity",
        message: `${character.name} is born ${character.born}, after this scene (${header.date}), and is present in it.`,
        line: headerLine(source, key),
        excerpt: name,
      });
    }
  }
  if (header.location && !findPlace(bible, header.location)) {
    out.push({
      path,
      check: "continuity",
      message: `The location "${header.location}" is not in the bible (bible/places/).`,
      line: headerLine(source, "location"),
      excerpt: header.location,
    });
  }
  return out;
}

/** Timeline: a scene dated before the scene it follows is flagged, unless its header says flashback: true. */
export function checkTimeline(path: string, source: string, header: SceneHeader, scenes: SceneRow[]): Finding[] {
  const date = storyDate(header.date);
  if (!date || header.flashback) return [];
  const ordered = readingOrder(scenes.filter((s) => s.path !== path).concat({ path, header }));
  const at = ordered.findIndex((s) => s.path === path);
  // The last scene before this one on the main line: a flashback does not move the story's clock.
  for (let i = at - 1; i >= 0; i--) {
    const prev = ordered[i]!;
    const prevDate = storyDate(prev.header.date);
    if (prev.header.flashback || !prevDate) continue;
    if (date < prevDate) {
      return [
        {
          path,
          check: "timeline",
          message: `Dated ${header.date}, before the scene it follows (${prev.path}, ${prev.header.date}), and not marked flashback: true.`,
          line: headerLine(source, "date"),
          excerpt: header.date,
        },
      ];
    }
    return [];
  }
  return [];
}

/** World rules: each rule's forbidden patterns, matched against the scene's prose. */
export function checkWorldRules(path: string, source: string, rules: RuleEntry[]): Finding[] {
  const { body, bodyLine } = parseFile(source);
  const out: Finding[] = [];
  for (const rule of rules) {
    for (const pattern of rule.forbidden) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "giu");
      } catch {
        continue; // Reported on the rule's own file by checkRuleFile.
      }
      for (const m of matchesIn(body, bodyLine, re)) {
        if (m.text === "") continue;
        out.push({ path, check: "world-rules", message: `Breaks the rule "${rule.name}" (forbidden: ${pattern}).`, line: m.line, excerpt: m.text });
      }
    }
  }
  return out;
}

/** A rule file whose pattern will not compile would never flag anything, so that is flagged on the rule. */
export function checkRuleFile(path: string, source: string, rule: RuleEntry): Finding[] {
  const out: Finding[] = [];
  for (const pattern of rule.forbidden) {
    try {
      new RegExp(pattern, "giu");
    } catch (error) {
      out.push({
        path,
        check: "world-rules",
        message: `The pattern ${pattern} is not a valid expression, so it matches nothing: ${error instanceof Error ? error.message : String(error)}`,
        line: headerLine(source, "forbidden"),
        excerpt: pattern,
      });
    }
  }
  return out;
}

// The conditions behind the AI habits. A word list alone teaches renaming (the site's ruling 117),
// so the constructions are matched too.
const NOT_JUST = [
  // "It's not just a house, it's a promise." / "This isn't only about money; it's about pride."
  /(?:\bnot|n['\u2019]t)\s+(?:just|only|merely|simply)\s+[^.!?;:,]{1,60}[,;:]\s*(?:it|this|that|he|she|they|we|you)(?:['\u2019](?:s|re)|\s+(?:is|was|are|were))\b/iu,
  // "It wasn't about money. It was about pride." / "It's not a house, it's a promise."
  /\b(?:it|this|that)(?:['\u2019]s\s+not|\s+is\s+not|\s+was\s+not|\s+isn['\u2019]t|\s+wasn['\u2019]t)\s+[^.!?;:]{1,50}[.,;:]\s*(?:it|this|that)(?:['\u2019]s|\s+(?:is|was))\b/iu,
];

/** A sentence that closes its paragraph on a three-item list of one- or two-word items. */
const CLOSING_TRIAD = /(?:^|[.!?]\s+)([^.!?]*?\b([\p{L}'\u2019]+(?:\s[\p{L}'\u2019]+)?),\s+([\p{L}'\u2019]+(?:\s[\p{L}'\u2019]+)?),?\s+(?:and|or)\s+([\p{L}'\u2019]+(?:\s[\p{L}'\u2019]+)?)[.!])\s*$/u;

export function checkAiHabits(path: string, source: string, habits: AiHabits): Finding[] {
  const { body, bodyLine } = parseFile(source);
  const out: Finding[] = [];
  for (const word of habits.words) {
    const re = new RegExp(`(?<![\\p{L}'\u2019])${escapeRegExp(word).replace(/'/g, "['\u2019]")}(?![\\p{L}])`, "giu");
    for (const m of matchesIn(body, bodyLine, re)) {
      out.push({ path, check: "ai-habits", message: `"${word}" is on the AI-habits list.`, line: m.line, excerpt: m.text });
    }
  }
  if (!habits.conditions) return out;

  // One flag per line for the construction, however many of the patterns see it.
  body.split("\n").forEach((line, i) => {
    const m = NOT_JUST.map((re) => re.exec(line)).find(Boolean);
    if (m) out.push({ path, check: "ai-habits", message: `The "not X, it's Y" construction.`, line: bodyLine + i, excerpt: m[0] });
  });

  const lines = body.split("\n");
  let start = 0;
  // Paragraphs, with the line each one ends on.
  for (let i = 0; i <= lines.length; i++) {
    if (i === lines.length || lines[i]!.trim() === "") {
      const paragraph = lines.slice(start, i).join(" ").trim();
      const m = CLOSING_TRIAD.exec(paragraph);
      if (m && !paragraph.startsWith("#")) {
        out.push({ path, check: "ai-habits", message: "The paragraph closes on a rule-of-three list.", line: bodyLine + Math.max(start, i - 1), excerpt: m[1]!.trim() });
      }
      start = i + 1;
    }
  }
  return out;
}

export function checkVoice(path: string, source: string, profile: Profile | null): Finding[] {
  if (!profile) return [];
  const reading = distanceFrom(profile, parseFile(source).body);
  if (!reading || reading.distance < VOICE_THRESHOLD) return [];
  return [
    {
      path,
      check: "voice",
      message: `Reads unlike your passages in shared/voice/ (distance ${reading.distance.toFixed(2)}, flagged from ${VOICE_THRESHOLD}): ${reading.furthest
        .map(describeFeature)
        .join("; ")}.`,
      line: null,
      excerpt: null,
    },
  ];
}

/** Every check that applies to a file of this kind. */
export function checkFile(path: string, source: string, context: BookContext): Finding[] {
  const kind = kindOf(path);
  const parsed = parseFile(source);
  const meta: Meta = readMeta(path, parsed.data, Object.keys(parsed.data).length > 0);
  if (meta.kind === "rule") return checkRuleFile(path, source, meta.entry);
  if (kind !== "scene" || meta.kind !== "scene") return [];
  return [
    ...checkHeader(path, source, meta.header, meta.hasHeader),
    ...checkContinuity(path, source, meta.header, context.bible),
    ...checkTimeline(path, source, meta.header, context.scenes),
    ...checkWorldRules(path, source, context.bible.rules),
    ...checkAiHabits(path, source, context.habits),
    ...checkVoice(path, source, context.voice),
  ];
}

/**
 * The key that keeps a dismissal: the same check saying the same thing about the same words. The
 * nth repeat of an identical finding gets its own key, so dismissing one does not hide the others.
 */
export async function fingerprints(found: Finding[]): Promise<string[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    found.map(async (f) => {
      const base = JSON.stringify([f.check, f.message, f.excerpt]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${base}#${n}`));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }),
  );
}
