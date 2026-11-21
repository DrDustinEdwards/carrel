// A book file and a Google Doc, both ways (the writing-tools ruling: Word
// and Google Docs "both directions, keeping tracked changes and comments"), for a coauthor who works in Docs.
//
// - Bring in: the Doc becomes the file's working copy in its room, with Google's pending suggestions as Carrel
//   suggestions (round "Google Docs", each by the person on the book whose name matches its author in Google, else
//   by whoever brought it in) and Google's open comment threads as Carrel threads on the same words. Nothing is
//   saved to Git: it is unsaved work in the room, saved, accepted or rejected there as any other.
// - Send back: what changed in the file since is laid in the same Doc as suggestions, never written over it,
//   through the same Docs functions every AI uses (docs.server.ts), labeled "Desk". A Google suggestion accepted or
//   rejected in Carrel is accepted or rejected in the Doc too when the file's text says which, and a thread started
//   in Carrel since goes in as a comment on its words.
//
// The Doc is in the manuscripts index and the Owner's, as every Docs tool requires. Formatting a Doc has that the
// editor does not (images, tables, colors) does not come in, and what goes back is text: a heading's level or a
// word's bold is not sent.

import type { BroughtThread } from "@dustinedwards/site-runtime/doc-room";
import { roomSchema, type JsonDoc } from "capsomer/behavior/collab-editor";
import { and, eq, gt, isNull, like, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, docLinks, people } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import { roomNames } from "~/lib/comments.server";
import type { Viewer } from "~/lib/people.server";
import { can, type Role } from "~/lib/roles";
import { replaceRoom, roomDocument, roomVersion } from "~/lib/rooms.server";

import {
  changeInDoc,
  commentInDoc,
  fetchDoc,
  indexed,
  openSuggestions,
  paragraphsOf,
  reviewInDoc,
  type Content,
  type EditAsked,
  type GoogleDoc,
  type Para,
  type Skipped,
  type Tab,
} from "./docs.server";

type Fetch = typeof fetch;
type Where = { id: number; role: Role };
type Mark = { type: string; attrs?: Record<string, unknown> };

/** The revision round Google's suggestions come in under, so a writer can take or drop them together. */
const ROUND = "Google Docs";
/** How a thread brought in from Google starts, so the next bring-in replaces it rather than doubling it. */
const FROM_DOCS = "From Google Docs";
/** A Google suggestion's id in Carrel, so a send knows which suggestions came from the Doc. */
const GOOGLE = "gdocs:";
/** The most edits Google takes in one call through changeInDoc. */
const EDITS_PER_CALL = 50;

/** Bringing a Doc in and sending it back are the Owner's, on a book he may edit: the Docs are his alone. */
function requireDocs(project: Where, viewer: Viewer) {
  if (!viewer.isOwner || !can(project.role, "edit"))
    throw new Response("Not found", { status: 404 });
}

type Built = {
  doc: JsonDoc;
  threads: BroughtThread[];
  /** Google's suggestion ids that came in as Carrel suggestions. */
  suggestions: string[];
  /** Pieces left out: images, page breaks, footnote marks and other things that are not text. */
  dropped: number;
  /** The Doc's text, paragraphs apart, for the day's count: none of it was typed in Carrel. */
  text: string;
};

/** Where each piece of Google's text went: its Google positions, and the editor block and offset it starts at. */
type Piece = { tab: string; start: number; end: number; block: number; offset: number };

function personIn(names: Record<string, string>, fallback: number) {
  const byName = new Map(Object.entries(names).map(([id, name]) => [name.toLowerCase(), id]));
  return (name: string | undefined) =>
    Number(byName.get((name ?? "").trim().toLowerCase()) ?? fallback);
}

function styleMarks(run: NonNullable<NonNullable<Content["paragraph"]>["elements"]>[number]) {
  const style = run.textRun?.textStyle ?? {};
  const marks: Mark[] = [];
  if (style.bold) marks.push({ type: "bold" });
  if (style.italic) marks.push({ type: "italic" });
  if (style.strikethrough) marks.push({ type: "strike" });
  if (style.link?.url) marks.push({ type: "link", attrs: { href: style.link.url } });
  return marks;
}

function isOrdered(tab: Tab, listId: string, level: number): boolean {
  const glyph = tab.documentTab?.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.glyphType;
  return Boolean(glyph && glyph !== "NONE" && glyph !== "GLYPH_TYPE_UNSPECIFIED");
}

/**
 * A Google Doc as the editor's JSON, its pending suggestions as suggestion marks and its open comment threads placed
 * on their words. `names` are the people on the book by id (roomNames); a Google author with one of their names is
 * that person, anyone else is `importer`. `before` are blocks kept ahead of the Doc's (the file's front matter).
 */
function docToEditor(
  doc: GoogleDoc,
  names: Record<string, string>,
  importer: number,
  before: JsonDoc[] = [],
): Built {
  const person = personIn(names, importer);
  const authors = new Map<string, { by: string; at: string | null }>();
  for (const t of doc.suggestions ?? [])
    if (t.suggestionId)
      authors.set(t.suggestionId, {
        by: String(person(t.headPost?.author?.displayName)),
        at: t.headPost?.createTime ?? null,
      });
  const suggestions = new Set<string>();
  const suggestion = (type: "insertion" | "deletion", id: string): Mark => {
    suggestions.add(id);
    const who = authors.get(id) ?? { by: String(importer), at: null };
    return { type, attrs: { id: `${GOOGLE}${id}`, by: who.by, round: ROUND, at: who.at } };
  };
  const blocks: JsonDoc[] = [...before];
  const pieces: Piece[] = [];
  let textblocks = 0;
  let dropped = 0;
  // The list being built: its id and the list node at each nesting level.
  let list: { id: string; levels: JsonDoc[] } | null = null;

  /** One paragraph's text and marks; null when it holds no text at all. */
  const paragraph = (p: NonNullable<Content["paragraph"]>, tab: string, type: JsonDoc) => {
    const content: JsonDoc[] = [];
    let offset = 0;
    let whole: Mark | null = null;
    let allSuggested = true;
    const block = textblocks;
    for (const el of p.elements ?? []) {
      const run = el.textRun;
      if (!run || run.content === undefined) {
        dropped++;
        continue;
      }
      let text = run.content;
      const ins = run.suggestedInsertionIds?.[0];
      const del = run.suggestedDeletionIds?.[0];
      const mark = ins ? suggestion("insertion", ins) : del ? suggestion("deletion", del) : null;
      if (text.endsWith("\n")) {
        text = text.slice(0, -1);
        // A paragraph wholly suggested in or out, its end too, is a whole-block suggestion.
        if (mark && allSuggested && (!whole || whole.attrs?.id === mark.attrs?.id)) whole = mark;
        else whole = null;
      }
      if (!mark) allSuggested = false;
      const marks = [...styleMarks(el), ...(mark ? [mark] : [])];
      if (el.startIndex !== undefined)
        pieces.push({ tab, start: el.startIndex, end: el.startIndex + text.length, block, offset });
      // A vertical tab is Google's line break.
      text.split("\u000b").forEach((part, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        if (part) content.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
      });
      offset += text.length;
    }
    if (!allSuggested) whole = null;
    if (!content.length) return null;
    textblocks++;
    const node: JsonDoc = { ...type, content };
    if (whole) {
      node.marks = [whole];
      node.attrs = { ...node.attrs, smark: JSON.stringify([whole]) };
    }
    return node;
  };

  const walk = (content: Content[] | undefined, tab: Tab, tabId: string) => {
    for (const c of content ?? []) {
      if (c.table) {
        list = null;
        for (const row of c.table.tableRows ?? [])
          for (const cell of row.tableCells ?? []) walk(cell.content, tab, tabId);
        continue;
      }
      if (!c.paragraph) continue;
      const style = c.paragraph.paragraphStyle?.namedStyleType ?? "";
      const level = /^HEADING_([1-6])$/.exec(style)?.[1] ?? (style === "TITLE" ? "1" : null);
      const bullet = c.paragraph.bullet;
      if (!bullet?.listId || level) {
        list = null;
        const node = paragraph(
          c.paragraph,
          tabId,
          level ? { type: "heading", attrs: { level: Number(level) } } : { type: "paragraph" },
        );
        if (node) blocks.push(node);
        continue;
      }
      const item = paragraph(c.paragraph, tabId, { type: "paragraph" });
      if (!item) continue;
      const depth = Math.max(0, bullet.nestingLevel ?? 0);
      const kind = (n: number) =>
        isOrdered(tab, bullet.listId!, n) ? "orderedList" : "bulletList";
      if (!list || list.id !== bullet.listId) {
        const root: JsonDoc = { type: kind(0), content: [] };
        blocks.push(root);
        list = { id: bullet.listId, levels: [root] };
      }
      while (list.levels.length - 1 > depth) list.levels.pop();
      if (depth > list.levels.length - 1) {
        // One level deeper, inside the last item; a jump of several levels nests by one.
        const parent = list.levels.at(-1)!;
        const last = parent.content?.at(-1);
        if (last) {
          const nested: JsonDoc = { type: kind(list.levels.length), content: [] };
          last.content!.push(nested);
          list.levels.push(nested);
        }
      }
      list.levels.at(-1)!.content!.push({ type: "listItem", content: [item] });
    }
  };
  const tabs = (all: Tab[] | undefined) => {
    for (const tab of all ?? []) {
      list = null;
      walk(tab.documentTab?.body?.content, tab, tab.tabProperties?.tabId ?? "");
      tabs(tab.childTabs);
    }
  };
  tabs(doc.tabs);
  if (blocks.length === before.length) blocks.push({ type: "paragraph" });
  const built: JsonDoc = { type: "doc", content: blocks };

  // Where each text block starts in the editor's positions, to place the threads.
  const node = roomSchema().nodeFromJSON(built);
  const starts: number[] = [];
  let seen = 0;
  node.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    // The front matter's blocks are not the Doc's.
    if (seen++ >= countTextblocks(before)) starts.push(pos + 1);
    return false;
  });
  const at = (tab: string, index: number): number | null => {
    const p = pieces.find((x) => x.tab === tab && index >= x.start && index <= x.end);
    return p && starts[p.block] !== undefined
      ? starts[p.block]! + p.offset + (index - p.start)
      : null;
  };
  const anchors = new Map<string, { tab: string; start?: number; end?: number }>();
  const anchorsIn = (all: Tab[] | undefined) => {
    for (const tab of all ?? []) {
      for (const [id, a] of Object.entries(tab.documentTab?.commentAnchors ?? {}))
        anchors.set(id, { tab: tab.tabProperties?.tabId ?? "", ...a.ranges?.[0] });
      anchorsIn(tab.childTabs);
    }
  };
  anchorsIn(doc.tabs);
  const threads: BroughtThread[] = [];
  for (const t of doc.comments ?? []) {
    if ((t.status ?? "OPEN") !== "OPEN") continue;
    const posts = [t.headPost, ...(t.replies ?? [])].filter((p) => p && !p.deleted && p.content);
    if (!posts.length) continue;
    const quote = t.plainTextQuote ?? "";
    const range = t.anchorId ? anchors.get(t.anchorId) : undefined;
    let from = range?.start !== undefined ? at(range.tab, range.start) : null;
    let to = range?.end !== undefined ? at(range.tab, range.end) : null;
    if ((from === null || to === null || from >= to) && quote) {
      // No anchor Carrel can place: the thread goes on its quoted words, where they appear once.
      const hit = findOnce(node, quote);
      from = hit?.from ?? null;
      to = hit?.to ?? null;
    }
    threads.push({
      from: from ?? 0,
      to: to ?? 0,
      quote,
      comments: posts.map((p) => ({
        personId: person(p!.author?.displayName),
        body: `${FROM_DOCS}, ${p!.author?.displayName ?? "someone"}: ${p!.content}`,
        ...(p!.createTime ? { createdAt: p!.createTime } : {}),
      })),
    });
  }
  return {
    doc: built,
    threads,
    suggestions: [...suggestions],
    dropped,
    text: node.textBetween(0, node.content.size, "\n\n", " "),
  };
}

function countTextblocks(blocks: JsonDoc[]): number {
  let n = 0;
  const count = (b: JsonDoc) => {
    if (b.type === "paragraph" || b.type === "heading") n++;
    b.content?.forEach(count);
  };
  blocks.forEach(count);
  return n;
}

/** The editor positions of `quote` when it appears exactly once inside one text block. */
function findOnce(
  node: ReturnType<ReturnType<typeof roomSchema>["nodeFromJSON"]>,
  quote: string,
): { from: number; to: number } | null {
  const hits: { from: number; to: number }[] = [];
  node.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    const own = n.textBetween(0, n.content.size, undefined, "￼");
    for (let i = own.indexOf(quote); i >= 0; i = own.indexOf(quote, i + 1))
      hits.push({ from: pos + 1 + i, to: pos + 1 + i + quote.length });
    return false;
  });
  return hits.length === 1 ? hits[0]! : null;
}

export async function readDocLink(db: D1Database, projectId: number, itemId: string) {
  return (
    (await drizzle(db)
      .select()
      .from(docLinks)
      .where(and(eq(docLinks.projectId, projectId), eq(docLinks.itemId, itemId)))
      .get()) ?? null
  );
}

/** The leading front matter of the file's working copy, which the Doc never had and keeps. */
function frontMatter(current: JsonDoc): JsonDoc[] {
  const out: JsonDoc[] = [];
  for (const b of current.content ?? []) {
    if (b.type !== "sourceBlock" || b.attrs?.kind !== "Front matter") break;
    out.push(b);
  }
  return out;
}

/**
 * The Doc as the file's working copy, for everyone in its room, with its suggestions and open threads. Threads an
 * earlier bring-in made are taken away first, so they are not doubled. Saved nowhere until someone saves the file.
 */
export async function bringInDoc(
  env: Env,
  project: Where,
  viewer: Viewer,
  itemId: string,
  docId: string,
  fetcher?: Fetch,
) {
  requireDocs(project, viewer);
  const row = await indexed(env, viewer, docId);
  const current = await roomDocument(env, project, itemId);
  if (!current) throw new Response("Open the file before bringing a Doc in.", { status: 409 });
  const doc = await fetchDoc(env, docId, fetcher);
  const built = docToEditor(
    doc,
    await roomNames(env.DB, project.id),
    viewer.id,
    frontMatter(current),
  );
  const now = new Date().toISOString();
  const d = drizzle(env.DB);
  await d
    .update(comments)
    .set({ deletedAt: now })
    .where(
      and(
        eq(comments.projectId, project.id),
        eq(comments.itemId, itemId),
        like(comments.body, `${FROM_DOCS}, %`),
        isNull(comments.deletedAt),
      ),
    );
  await replaceRoom(env, project, viewer, itemId, {
    markdown: "",
    version: await roomVersion(env, project, itemId),
    unsaved: true,
    doc: built.doc,
    threads: built.threads,
  });
  const link = {
    docId,
    personId: viewer.id,
    brought: JSON.stringify(built.suggestions),
    revisionId: doc.revisionId ?? null,
    syncedAt: now,
  };
  await d
    .insert(docLinks)
    .values({ projectId: project.id, itemId, ...link })
    .onConflictDoUpdate({ target: [docLinks.projectId, docLinks.itemId], set: link });
  return {
    title: row.name || doc.title,
    suggestions: built.suggestions.length,
    threads: built.threads.length,
    dropped: built.dropped,
    text: built.text,
  };
}

const isGoogle = (m: Mark) => String(m.attrs?.id ?? "").startsWith(GOOGLE);

/**
 * Each text block's words as the file proposes them: Carrel's own suggestions taken, Google's still pending left as
 * the Doc has them (an insertion out, a deletion in), so only what Carrel changed differs from the Doc.
 */
function proposedText(doc: JsonDoc): { blocks: string[]; pending: Set<string> } {
  const blocks: string[] = [];
  const pending = new Set<string>();
  const keeps = (marks: Mark[] | undefined) => {
    for (const m of marks ?? []) {
      if (m.type !== "insertion" && m.type !== "deletion") continue;
      if (isGoogle(m)) pending.add(String(m.attrs!.id).slice(GOOGLE.length));
      if (m.type === "insertion") return !isGoogle(m);
      return isGoogle(m);
    }
    return true;
  };
  const inline = (n: JsonDoc): string => {
    if (n.type === "text") return keeps(n.marks) ? (n.text ?? "") : "";
    if (n.type === "hardBreak") return keeps(n.marks) ? "\u000b" : "";
    if (n.type === "sourceInline") return String(n.attrs?.text ?? "");
    return (n.content ?? []).map(inline).join("");
  };
  const walk = (n: JsonDoc) => {
    const own = n.marks ?? (n.attrs?.smark ? (JSON.parse(String(n.attrs.smark)) as Mark[]) : []);
    if (!keeps(own)) {
      // A block left out still names the Google suggestions inside it as pending.
      for (const id of proposedText({ type: "doc", content: n.content ?? [] }).pending)
        pending.add(id);
      return;
    }
    if (n.type === "paragraph" || n.type === "heading") {
      const text = (n.content ?? []).map(inline).join("");
      if (text) blocks.push(text);
    } else if (n.type === "sourceBlock") {
      if (n.attrs?.kind !== "Front matter" && n.attrs?.text) blocks.push(String(n.attrs.text));
    } else (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return { blocks, pending };
}

/** A Doc paragraph's words with its pending suggestions as they stand (insertions out), `taken` accepted. */
function paraWords(p: Para, taken: ReadonlySet<string> = new Set()): string {
  return p.segs
    .map((s) => {
      const mine = (s.ids ?? []).some((id) => taken.has(id));
      if (s.state === "plain") return s.text;
      if (s.state === "deleted") return mine ? "" : s.text;
      if (s.state === "inserted") return mine ? s.text : "";
      return "";
    })
    .join("")
    .replace(/\n$/, "");
}

/** How often `quote` appears inside the paragraphs (never across two). */
function count(paras: string[], quote: string): number {
  let n = 0;
  for (const p of paras) for (let i = p.indexOf(quote); i >= 0; i = p.indexOf(quote, i + 1)) n++;
  return n;
}

/** The longest common subsequence of two lists of paragraphs, as pairs of indexes. */
function common(a: string[], b: string[]): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const w = y.length + 1;
  const dp = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i * w + j] =
        x[i] === y[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      pairs.push([head + i, head + j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

/** The start of the word `at` falls in (or `at`, at a space). */
const wordStart = (s: string, at: number) => {
  while (at > 0 && !/\s/.test(s[at - 1]!)) at--;
  return at;
};
const wordEnd = (s: string, at: number) => {
  while (at < s.length && !/\s/.test(s[at]!)) at++;
  return at;
};

/** Grows [from, to) in `p` a word at a time on each side until the words appear once among `paras`. */
function unique(paras: string[], p: string, from: number, to: number): [number, number] | null {
  for (;;) {
    const quote = p.slice(from, to);
    if (quote.trim() && count(paras, quote) === 1) return [from, to];
    if (from === 0 && to === p.length) return null;
    from = from > 0 ? wordStart(p, from - 1) : 0;
    to = to < p.length ? wordEnd(p, to + 1) : p.length;
  }
}

/** One changed paragraph as the smallest edit, with `extra` (new paragraphs after it) on its end. */
function changeOf(paras: string[], d: string, c: string, extra: string[]): EditAsked | null {
  let p = 0;
  while (p < d.length && p < c.length && d[p] === c[p]) p++;
  let s = 0;
  while (s < d.length - p && s < c.length - p && d[d.length - 1 - s] === c[c.length - 1 - s]) s++;
  p = wordStart(d, p);
  let dEnd = d.length - s;
  if (extra.length) dEnd = d.length;
  else dEnd = wordEnd(d, dEnd);
  const cEnd = c.length - (d.length - dEnd);
  const span = unique(paras, d, p, Math.max(dEnd, p));
  if (!span) return null;
  const [from, to] = span;
  const replace = d.slice(from, p) + c.slice(p, cEnd) + d.slice(dEnd, to);
  const tail = extra.length ? `\n${extra.join("\n")}` : "";
  if (to > from) return { find: d.slice(from, to), replace: replace + tail };
  return null;
}

/**
 * The edits that turn the Doc's paragraphs into the file's: each changed paragraph its smallest change, new
 * paragraphs after the one before them, a paragraph gone its words taken out.
 */
export function editsBetween(doc: string[], file: string[]): EditAsked[] {
  const pairs = common(doc, file);
  const edits: EditAsked[] = [];
  let i = 0;
  let j = 0;
  const hunk = (iEnd: number, jEnd: number) => {
    const dels = doc.slice(i, iEnd);
    const ins = file.slice(j, jEnd);
    const k = Math.min(dels.length, ins.length);
    for (let n = 0; n < k; n++) {
      const extra = n === k - 1 ? ins.slice(k) : [];
      const e = changeOf(doc, dels[n]!, ins[n]!, extra);
      if (e) edits.push(e);
    }
    if (k === 0 && ins.length) {
      const before = doc[i - 1];
      const after = doc[iEnd];
      if (before !== undefined) {
        const span = unique(
          doc,
          before,
          wordStart(before, Math.max(0, before.length - 1)),
          before.length,
        );
        if (span)
          edits.push({ insert_after: before.slice(span[0], span[1]), text: `\n${ins.join("\n")}` });
      } else if (after !== undefined) {
        const span = unique(doc, after, 0, wordEnd(after, 0));
        if (span) {
          const words = after.slice(span[0], span[1]);
          edits.push({ find: words, replace: `${ins.join("\n")}\n${words}` });
        }
      }
    }
    for (const gone of dels.slice(k))
      if (gone.trim() && count(doc, gone) === 1) edits.push({ find: gone, replace: "" });
  };
  for (const [a, b] of pairs) {
    if (a > i || b > j) hunk(a, b);
    i = a + 1;
    j = b + 1;
  }
  if (i < doc.length || j < file.length) hunk(doc.length, file.length);
  return edits;
}

/**
 * The file's changes since it was brought in, into its Doc as suggestions, and its new threads as comments. A
 * Google suggestion decided in Carrel is decided in the Doc the same way when the file's text shows which; one it
 * cannot tell stays open, and the answer says so.
 */
export async function sendToDoc(
  env: Env,
  project: Where,
  viewer: Viewer,
  itemId: string,
  fetcher?: Fetch,
) {
  requireDocs(project, viewer);
  const link = await readDocLink(env.DB, project.id, itemId);
  if (!link) throw new AiRefusal("This file did not come from a Google Doc. Bring one in first.");
  await indexed(env, viewer, link.docId, "suggest");
  const current = await roomDocument(env, project, itemId);
  if (!current) throw new Response("Open the file before sending it.", { status: 409 });
  const session: AiSession = { viewer, client: "Desk" };
  const reason = `from the book file ${itemId}`;
  const { blocks, pending } = proposedText(current);
  const whole = blocks.join("\n");
  let doc = await fetchDoc(env, link.docId, fetcher);

  // Google's suggestions Carrel decided: the same decision in the Doc, when the file's text says which.
  const open = openSuggestions(doc);
  const decided = (JSON.parse(link.brought) as string[]).filter(
    (id) => open.has(id) && !pending.has(id),
  );
  const accept: string[] = [];
  const reject: string[] = [];
  let unsure = 0;
  const paras = paragraphsOf(doc);
  for (const id of decided) {
    const own = paras.filter((p) => p.segs.some((s) => s.ids?.includes(id)));
    const taken = own.every((p) => whole.includes(paraWords(p, new Set([id]))));
    const left = own.every((p) => whole.includes(paraWords(p)));
    if (taken && !left) accept.push(id);
    else if (left && !taken) reject.push(id);
    else unsure++;
  }
  const refused: string[] = [];
  for (const [action, ids] of [
    ["accept", accept],
    ["reject", reject],
  ] as const) {
    if (!ids.length) continue;
    try {
      await reviewInDoc(
        env,
        viewer,
        session,
        link.docId,
        { action, suggestions: ids, reason },
        fetcher,
      );
    } catch (error) {
      if (!(error instanceof AiRefusal)) throw error;
      refused.push(error.message);
      ids.length = 0;
    }
  }
  if (accept.length || reject.length) doc = await fetchDoc(env, link.docId, fetcher);

  // The text: every difference as a suggestion.
  const docParas = paragraphsOf(doc)
    .map((p) => paraWords(p))
    .filter((t) => t.trim());
  const edits = editsBetween(docParas, blocks);
  const skipped: Skipped[] = [];
  let suggested = 0;
  for (let at = 0; at < edits.length; at += EDITS_PER_CALL) {
    try {
      const done = await changeInDoc(
        env,
        viewer,
        session,
        link.docId,
        { edits: edits.slice(at, at + EDITS_PER_CALL), reason, skipUnfound: true },
        fetcher,
      );
      suggested += done.edits;
      skipped.push(...(done.skipped ?? []));
    } catch (error) {
      if (!(error instanceof AiRefusal)) throw error;
      skipped.push({ quote: "", why: error.message });
    }
  }

  // Threads started in Carrel since the last bring-in or send, as comments on their words.
  const d = drizzle(env.DB);
  const threads = await d
    .select({ body: comments.body, quote: comments.quote, name: people.name, email: people.email })
    .from(comments)
    .innerJoin(people, eq(people.id, comments.personId))
    .where(
      and(
        eq(comments.projectId, project.id),
        eq(comments.itemId, itemId),
        isNull(comments.parentId),
        isNull(comments.deletedAt),
        isNull(comments.resolvedAt),
        gt(comments.createdAt, link.syncedAt),
        not(like(comments.body, `${FROM_DOCS}, %`)),
      ),
    )
    .all();
  let commented = 0;
  for (const t of threads) {
    const quote = t.quote.split("\n")[0]!.trim();
    if (!quote) continue;
    try {
      await commentInDoc(
        env,
        viewer,
        session,
        link.docId,
        { text: `${t.name || t.email}: ${t.body}`.slice(0, 1700), quote },
        fetcher,
      );
      commented++;
    } catch (error) {
      if (!(error instanceof AiRefusal)) throw error;
      skipped.push({ quote, why: error.message });
    }
  }
  const after = await fetchDoc(env, link.docId, fetcher);
  await d
    .update(docLinks)
    .set({ syncedAt: new Date().toISOString(), revisionId: after.revisionId ?? null })
    .where(and(eq(docLinks.projectId, project.id), eq(docLinks.itemId, itemId)));
  return {
    suggested,
    accepted: accept.length,
    rejected: reject.length,
    undecided: unsure,
    commented,
    skipped,
    refused,
  };
}
