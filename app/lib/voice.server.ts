// The voice pack of a site project: what an AI session reads before it drafts a post, and what its draft
// is scanned against. Real examples copy a voice better than a description of it (Wang et al., Findings
// of EMNLP 2025), so the pack is the Owner's guide and excerpts of the author's own writing, chosen to
// hold one of their long sentences and one of their short ones. The writing is what the Owner pastes on
// the Voice page when there is any, and the published posts only when there is none: a published post
// may have been drafted by a model, and excerpts of it would teach a session a model's voice. No measured averages go to a
// session (an average sentence length is a length a model then writes every time) and no word lists.
//
// After a draft, site-runtime's slopScan names the spans that read unlike the excerpts: sentence length
// against the author's own spread, a model's filler, a model's words the excerpts never use, joiner
// dashes. It flags, with one instruction to edit those spans in place; it never rewrites, and it never
// holds a save or a publish. The author decides.
//
// Nothing here scores a draft against an AI detector. The aim is a post that reads like its author.

import { copiedRuns, instructionFor, slopScan, voiceExcerpts, WRITING_RULES, type SlopFinding } from "@dustinedwards/site-runtime/prose";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { siteItems, voicePacks } from "~/db/schema";
import type { ProjectRole } from "~/lib/content.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient } from "~/lib/sites.server";

/** The newest published posts a pack is built from: enough to show a range, few enough for one request's subrequests. */
export const PACK_POSTS = 40;
/** Excerpts handed to a session: the research's few-shot range, and short enough to read in full. */
const PACK_EXCERPTS = 6;

/** Where the excerpts came from: the author's own writing pasted on the Voice page, or the published posts. */
export type VoiceSource = "own" | "posts";

export type VoicePack = {
  guide: string;
  own: string;
  excerpts: string[];
  from: VoiceSource;
  /** The pieces of own writing, or the posts, the excerpts were chosen from. */
  pieces: number;
  builtAt: string | null;
};

/** A finding on a draft: the scan's four kinds, and a run copied from an excerpt (which carries an old post's facts). */
export type DraftFinding = Omit<SlopFinding, "kind" | "line"> & { kind: SlopFinding["kind"] | "copied"; line: number | null };

export type DraftCheck = {
  findings: DraftFinding[];
  /** What to hand the session that wrote the draft: edit these spans in place. Null when there is nothing to fix. */
  instruction: string | null;
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
 * A post's prose: the frontmatter, code, HTML, images and Markdown marks taken out, link text kept. An
 * excerpt of the raw source would show a model brackets and markup as the author's style.
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
  if (!row) return { guide: "", own: "", excerpts: [], from: "posts", pieces: 0, builtAt: null };
  const from: VoiceSource = piecesOf(row.own).length ? "own" : "posts";
  return { guide: row.guide, own: row.own, excerpts: strings(row.excerpts), from, pieces: row.posts, builtAt: row.builtAt };
}

/** The pieces of the author's own writing: the pasted text split at each line holding only ---. */
function piecesOf(own: string): string[] {
  return own
    .replace(/\r\n/g, "\n")
    .split(/^\s*---\s*$/m)
    .map(proseOf)
    .filter(Boolean);
}

async function storeExcerpts(db: D1Database, projectId: number, texts: string[], now: Date) {
  const values = { excerpts: JSON.stringify(voiceExcerpts(texts, PACK_EXCERPTS)), posts: texts.length, builtAt: now.toISOString(), updatedAt: now.toISOString() };
  await drizzle(db)
    .insert(voicePacks)
    .values({ projectId, ...values })
    .onConflictDoUpdate({ target: voicePacks.projectId, set: values });
}

/** A project's excerpts with no role check, for Carrel's own lint of a social post; none when the pack is not built. */
export async function packExcerpts(db: D1Database, projectId: number): Promise<string[]> {
  const row = await drizzle(db).select({ excerpts: voicePacks.excerpts }).from(voicePacks).where(eq(voicePacks.projectId, projectId)).get();
  return row ? strings(row.excerpts) : [];
}

/**
 * Rebuilds the excerpts: from the author's own writing when there is any, else from the newest published
 * posts the index knows, read from the site. Anyone who may read the project may rebuild: it reads only
 * what the Owner pasted or what is published.
 */
export async function buildVoicePack(env: Env, project: SiteProject, fetcher?: typeof fetch, now = new Date()): Promise<VoicePack> {
  if (!can(project.role, "read")) forbid();
  const own = piecesOf((await readVoicePack(env.DB, project)).own);
  if (own.length) {
    await storeExcerpts(env.DB, project.id, own, now);
    return readVoicePack(env.DB, project);
  }
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
  await storeExcerpts(env.DB, project.id, texts, now);
  return readVoicePack(env.DB, project);
}

/**
 * The Owner's part of the pack: the guide and the author's own writing. New own writing becomes the
 * excerpts at once; with none left, the pack is marked unbuilt, so the next brief reads the published posts.
 */
export async function saveVoiceGuide(db: D1Database, project: ProjectRole, input: { guide: string; own: string }, now = new Date()) {
  if (!can(project.role, "manage")) forbid();
  const own = input.own.replace(/\r\n/g, "\n").trim();
  const values = { guide: input.guide.trim(), own, updatedAt: now.toISOString(), ...(own ? {} : { builtAt: null }) };
  await drizzle(db)
    .insert(voicePacks)
    .values({ projectId: project.id, ...values })
    .onConflictDoUpdate({ target: voicePacks.projectId, set: values });
  const pieces = piecesOf(own);
  if (pieces.length) await storeExcerpts(db, project.id, pieces, now);
}

const WORD = /[\p{L}]+(?:['’][\p{L}]+)*/gu;

/** The line a copied run (lower-case words, as copiedRuns gives it) starts on, or null when its opening words break across lines. */
function lineOf(body: string, run: string, firstLine: number): number | null {
  const opening = run.split(" ").slice(0, 3).join(" ");
  const at = body.split("\n").findIndex((l) => ` ${(l.toLowerCase().match(WORD) ?? []).join(" ")} `.includes(` ${opening} `));
  return at < 0 ? null : firstLine + at;
}

/**
 * The scan of a text against the author's excerpts: slopScan's findings, then any run of eight words or more
 * copied from an excerpt, and one instruction covering both. `firstLine` is the file line the text starts on.
 * Flags only; the author decides.
 */
export function scanAgainst(excerpts: string[], body: string, firstLine = 1, sources?: string[]): DraftCheck {
  const scan = slopScan(body, excerpts, { firstLine, sources });
  const copied: DraftFinding[] = copiedRuns(body, excerpts).map((run) => {
    const ws = run.split(" ");
    return {
      kind: "copied",
      excerpt: ws.length > 12 ? `${ws.slice(0, 10).join(" ")} …` : run,
      line: lineOf(body, run, firstLine),
      say: "Copied word for word from an excerpt. Write it in this piece's own words, with this piece's facts.",
    };
  });
  const findings: DraftFinding[] = [...scan.findings, ...copied];
  return { findings, instruction: instructionFor(findings, scan.spread) };
}

/**
 * The scan on a post's text, frontmatter and all, against this project's pack: against every piece of the author's own
 * writing when there is any (the measures are steadier on all of it than on the six excerpts a session reads), else
 * against the excerpts. `sources`, the text of what the draft drew on, turns on the check of its names and numbers.
 */
export function checkAgainstPack(pack: VoicePack, source: string, sources?: string[]): DraftCheck {
  const text = source.replace(/\r\n/g, "\n");
  const front = /^---\n[\s\S]*?\n---\n?/.exec(text);
  const firstLine = front ? front[0].split("\n").length - (front[0].endsWith("\n") ? 1 : 0) + 1 : 1;
  const reference = pack.from === "own" ? piecesOf(pack.own) : pack.excerpts;
  return scanAgainst(reference, front ? text.slice(front[0].length) : text, firstLine, sources);
}

export type VoiceBrief = {
  rules: string;
  guide: string;
  excerpts: string[];
  from: VoiceSource;
  pieces: number;
  builtAt: string | null;
};

/** What the excerpts are for, said where a session reads them. */
const EXCERPTS_RULE = "- The excerpts show how the author writes. Never copy their facts, names, claims or sentences.";

/** Everything a session reads before it drafts: the rules, the author's guide and the excerpts. */
export function briefOf(pack: VoicePack): VoiceBrief {
  return { rules: `${WRITING_RULES}\n${EXCERPTS_RULE}`, guide: pack.guide, excerpts: pack.excerpts, from: pack.from, pieces: pack.pieces, builtAt: pack.builtAt };
}
