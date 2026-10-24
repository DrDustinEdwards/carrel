// The voice pack of a site project: what an AI session reads before it drafts a post, and what its draft
// is checked against. Real examples copy a voice better than a description of it (Wang et al., Findings
// of EMNLP 2025), so the pack is built from the author's own published posts: a measured profile and the
// excerpts nearest it. The guide and the word lists are the Owner's, on the project's Voice page. The
// checks are site-runtime's ./prose, the one check Carrel's books and Foxhound's emails also run.
//
// Learning from edits: when the author publishes a post an AI session drafted, the words the latest AI
// draft used and the published post does not are counted. One cut in three posts, and never kept in one,
// is offered on the Voice page for the phrase list. The author decides; nothing is added on its own.
//
// Nothing here scores a draft against an AI detector. The aim is a post that reads like its author.

import {
  checkProse,
  describeFeature,
  distanceFrom,
  nearestPassages,
  profileOf,
  VOICE_THRESHOLD,
  WRITING_RULES,
  type Profile,
  type ProseIssue,
} from "@dustinedwards/site-runtime/prose";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts, siteItems, voiceCuts, voicePacks } from "~/db/schema";
import type { ProjectRole } from "~/lib/content.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient } from "~/lib/sites.server";

/** The newest published posts a pack is built from: enough for a profile, few enough for one request's subrequests. */
export const PACK_POSTS = 40;
/** Excerpts handed to a session: the research's few-shot range, and short enough to read in full. */
const PACK_EXCERPTS = 6;
/** A cut offered for the list once it has been cut from this many posts and kept in none. */
export const CUT_SUGGEST_AT = 3;
/** The most new cut candidates one publish records, so one heavy rewrite cannot flood the table. */
const CUTS_PER_PUBLISH = 150;

export type VoicePack = {
  guide: string;
  phrases: string[];
  allow: string[];
  profile: Profile | null;
  excerpts: string[];
  posts: number;
  builtAt: string | null;
};

export type DraftCheck = {
  issues: ProseIssue[];
  /** How far the draft reads from the published posts, and the three measures furthest off; null without a profile or under 250 words. */
  voice: { distance: number; threshold: number; unlike: boolean; furthest: string[] } | null;
};

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

function strings(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A post's prose for measuring: the frontmatter, code, HTML, images and Markdown marks taken out, link
 * text kept. Measured on the raw source, every post would read as heavy on colons and brackets.
 */
export function proseOf(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|\*|_)(?=\S)([^*_]+?)\1/g, "$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readVoicePack(db: D1Database, project: ProjectRole): Promise<VoicePack> {
  if (!can(project.role, "read")) forbid();
  const row = await drizzle(db).select().from(voicePacks).where(eq(voicePacks.projectId, project.id)).get();
  if (!row) return { guide: "", phrases: [], allow: [], profile: null, excerpts: [], posts: 0, builtAt: null };
  return {
    guide: row.guide,
    phrases: strings(row.phrases),
    allow: strings(row.allow),
    profile: row.profile ? (JSON.parse(row.profile) as Profile) : null,
    excerpts: strings(row.excerpts),
    posts: row.posts,
    builtAt: row.builtAt,
  };
}

/**
 * Rebuilds the profile and excerpts from the newest published posts the index knows, read from the site.
 * Anyone who may read the project may rebuild: it reads only what is published.
 */
export async function buildVoicePack(env: Env, project: SiteProject, fetcher?: typeof fetch, now = new Date()): Promise<VoicePack> {
  if (!can(project.role, "read")) forbid();
  const rows = await drizzle(env.DB)
    .select({ itemId: siteItems.itemId })
    .from(siteItems)
    .where(and(eq(siteItems.projectId, project.id), eq(siteItems.status, "published"), isNotNull(siteItems.publishedAt)))
    .orderBy(desc(siteItems.publishedAt))
    .limit(PACK_POSTS)
    .all();
  const client = siteClient(env, project.site, fetcher);
  const texts: string[] = [];
  // One at a time: a site answers its own API, and a burst of forty is no faster for it.
  for (const { itemId } of rows) {
    try {
      const doc = await client.get(itemId);
      const prose = proseOf(doc.source);
      if (prose) texts.push(prose);
    } catch (error) {
      console.error(JSON.stringify({ voice: "post-unreadable", itemId, error: String(error) }));
    }
  }
  const profile = profileOf(texts);
  const excerpts = profile ? nearestPassages(profile, texts, PACK_EXCERPTS) : [];
  const values = { profile: profile ? JSON.stringify(profile) : null, excerpts: JSON.stringify(excerpts), posts: texts.length, builtAt: now.toISOString(), updatedAt: now.toISOString() };
  await drizzle(env.DB)
    .insert(voicePacks)
    .values({ projectId: project.id, ...values })
    .onConflictDoUpdate({ target: voicePacks.projectId, set: values });
  return readVoicePack(env.DB, project);
}

/** One entry per line, trimmed, blank lines and repeats dropped. */
export function listFrom(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))];
}

/** The Owner's part of the pack: the guide and the two word lists. */
export async function saveVoiceGuide(db: D1Database, project: ProjectRole, input: { guide: string; phrases: string[]; allow: string[] }, now = new Date()) {
  if (!can(project.role, "manage")) forbid();
  const values = { guide: input.guide.trim(), phrases: JSON.stringify(input.phrases), allow: JSON.stringify(input.allow), updatedAt: now.toISOString() };
  await drizzle(db)
    .insert(voicePacks)
    .values({ projectId: project.id, ...values })
    .onConflictDoUpdate({ target: voicePacks.projectId, set: values });
}

/** Dashes are flagged unless the author's own posts use them, one in 1,000 words or more. */
function dashes(pack: VoicePack): "flag" | "allow" {
  return (pack.profile?.mean.dashes ?? 0) >= 1 ? "allow" : "flag";
}

/** The checks on a post's text against this project's pack. Flags only; the author decides. */
export function checkAgainstPack(pack: VoicePack, source: string): DraftCheck {
  const front = /^---\n[\s\S]*?\n---\n?/.exec(source.replace(/\r\n/g, "\n"));
  const firstLine = front ? front[0].split("\n").length - (front[0].endsWith("\n") ? 1 : 0) + 1 : 1;
  const body = front ? source.replace(/\r\n/g, "\n").slice(front[0].length) : source;
  const issues = checkProse(body, { phrases: pack.phrases, allow: pack.allow, dashes: dashes(pack), firstLine });
  const reading = pack.profile ? distanceFrom(pack.profile, proseOf(source)) : null;
  return {
    issues,
    voice: reading
      ? { distance: Math.round(reading.distance * 100) / 100, threshold: VOICE_THRESHOLD, unlike: reading.distance >= VOICE_THRESHOLD, furthest: reading.furthest.map(describeFeature) }
      : null,
  };
}

/** What the published posts measure, in words a session can write to. */
function measures(profile: Profile | null): string[] {
  if (!profile) return [];
  const m = profile.mean;
  const round = (n: number) => Math.round(n * 10) / 10;
  return [
    `Sentences average ${round(m["sentence length"] ?? 0)} words.`,
    `${round(m.contractions ?? 0)} contractions per 1,000 words.`,
    `${round(m.dashes ?? 0)} dashes, ${round(m.semicolons ?? 0)} semicolons, ${round(m.questions ?? 0)} questions and ${round(m.exclamations ?? 0)} exclamation marks per 1,000 words.`,
    `"I" ${round(m['"i"'] ?? 0)} and "you" ${round(m['"you"'] ?? 0)} times per 1,000 words.`,
  ];
}

export type VoiceBrief = {
  rules: string;
  guide: string;
  phrases: string[];
  allow: string[];
  measures: string[];
  excerpts: string[];
  posts: number;
  builtAt: string | null;
};

/** Everything a session reads before it drafts: the rules, the author's guide and lists, the measures and the excerpts. */
export function briefOf(pack: VoicePack): VoiceBrief {
  return {
    rules: WRITING_RULES,
    guide: pack.guide,
    phrases: pack.phrases,
    allow: pack.allow,
    measures: measures(pack.profile),
    excerpts: pack.excerpts,
    posts: pack.posts,
    builtAt: pack.builtAt,
  };
}

// ---------- learning from edits

/** Words too common to say anything about a voice. */
const COMMON = new Set(
  (
    "the a an and or but if then than so of to in on at by for with from as into onto over under about after before " +
    "is are was were be been being am do does did done have has had having will would can could should may might must " +
    "it its it's this that these those there here what which who whom whose when where why how not no yes all any some " +
    "each every more most less many much few very just also only even still too own same other such both either neither " +
    "i me my we us our you your he him his she her they them their one two first new out up down off again once"
  ).split(" "),
);

/** The words and two-word phrases of a text worth counting: lower case, no common-word-only phrases. */
export function phrasesOf(text: string): Set<string> {
  const words = proseOf(text).toLowerCase().match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) ?? [];
  const out = new Set<string>();
  words.forEach((w, i) => {
    if (w.length >= 4 && !COMMON.has(w)) out.add(w);
    const next = words[i + 1];
    if (next && (!COMMON.has(w) || !COMMON.has(next)) && w.length + next.length >= 7) out.add(`${w} ${next}`);
  });
  return out;
}

/**
 * After the author publishes `itemId`: counts what the latest AI draft of it had and the published text
 * does not, and marks every listed cut the published text kept. A post counts once per phrase however
 * often it is republished. Never throws: learning is not worth a failed publish.
 */
export async function recordCuts(db: D1Database, projectId: number, personId: number, itemId: string, published: string, now = new Date()): Promise<number> {
  try {
    const draft = await drizzle(db)
      .select({ source: aiDrafts.source })
      .from(aiDrafts)
      .where(and(eq(aiDrafts.projectId, projectId), eq(aiDrafts.itemId, itemId), eq(aiDrafts.personId, personId)))
      .orderBy(desc(aiDrafts.createdAt), desc(aiDrafts.id))
      .get();
    if (!draft) return 0;
    const kept = phrasesOf(published);
    const cut = [...phrasesOf(draft.source)].filter((p) => !kept.has(p)).slice(0, CUTS_PER_PUBLISH);
    const known = await drizzle(db).select().from(voiceCuts).where(eq(voiceCuts.projectId, projectId)).all();
    const byPhrase = new Map(known.map((row) => [row.phrase, row]));
    const writes = [];
    for (const row of known) {
      if (kept.has(row.phrase)) writes.push(drizzle(db).update(voiceCuts).set({ kept: row.kept + 1 }).where(and(eq(voiceCuts.projectId, projectId), eq(voiceCuts.phrase, row.phrase))));
    }
    for (const phrase of cut) {
      const row = byPhrase.get(phrase);
      const items = row ? strings(row.items) : [];
      if (items.includes(itemId)) continue;
      const set = { items: JSON.stringify([...items, itemId]), lastCutAt: now.toISOString() };
      writes.push(drizzle(db).insert(voiceCuts).values({ projectId, phrase, ...set }).onConflictDoUpdate({ target: [voiceCuts.projectId, voiceCuts.phrase], set }));
    }
    for (const w of writes) await w;
    return cut.length;
  } catch (error) {
    console.error(JSON.stringify({ voice: "cuts-failed", itemId, error: String(error) }));
    return 0;
  }
}

export type CutSuggestion = { phrase: string; posts: number; lastCutAt: string };

/** Cuts seen in CUT_SUGGEST_AT posts or more, kept in none, not set aside and not already listed: most posts first. */
export async function cutSuggestions(db: D1Database, project: ProjectRole, pack: VoicePack): Promise<CutSuggestion[]> {
  if (!can(project.role, "read")) forbid();
  const listed = new Set([...pack.phrases, ...pack.allow].map((p) => p.toLowerCase()));
  const rows = await drizzle(db)
    .select()
    .from(voiceCuts)
    .where(and(eq(voiceCuts.projectId, project.id), eq(voiceCuts.kept, 0), eq(voiceCuts.setAside, false)))
    .all();
  return rows
    .map((r) => ({ phrase: r.phrase, posts: strings(r.items).length, lastCutAt: r.lastCutAt }))
    .filter((r) => r.posts >= CUT_SUGGEST_AT && !listed.has(r.phrase))
    .sort((a, b) => b.posts - a.posts || a.phrase.localeCompare(b.phrase))
    .slice(0, 50);
}

/** The Owner's answer to a suggestion: add it to the phrase list, or set it aside for good. */
export async function decideCut(db: D1Database, project: ProjectRole, phrase: string, decision: "add" | "set-aside") {
  if (!can(project.role, "manage")) forbid();
  if (decision === "add") {
    const pack = await readVoicePack(db, project);
    await saveVoiceGuide(db, project, { guide: pack.guide, phrases: [...new Set([...pack.phrases, phrase])], allow: pack.allow });
  }
  await drizzle(db).update(voiceCuts).set({ setAside: true }).where(and(eq(voiceCuts.projectId, project.id), eq(voiceCuts.phrase, phrase)));
}
