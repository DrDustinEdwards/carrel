// Google Docs through the service account (the Docs plan, slices 1 to 3): read a Doc with its pending suggestions and
// its comments, lay edits in as suggestions, comment, and, on Dustin's own ask, write directly, accept or reject, and
// take a change back. One path for every AI: the MCP tools call these functions and nothing else reaches a Doc. The
// rules live here and in service-account.server.ts:
//
// - Owner only, and only a Doc in the manuscripts index (the shared folder), so a Doc someone shared with the
//   robot elsewhere is out of reach.
// - A change to a Doc's text is a suggestion unless the call asks for a direct write, and an accept is a direct
//   change too; both are refused on a Doc Dustin locked "suggest only", and every tool is refused on one he locked
//   "no AI" (doc_locks, set on Desk's Manuscripts page).
// - Every suggestion and comment says which AI made it and why, in the Doc itself, and every change is a row in
//   doc_changes (suggestions and comments) or doc_actions (writes, decisions, undos). A direct write keeps the text
//   it replaced and the whole Doc's text before it, so it can be taken back, and emails Dustin by his Docs email
//   setting (each write, a daily summary, or off).
// An AI names text by quoting it. Carrel turns the quote into Google's positions from a fresh read, so no AI does
// position arithmetic, and a quote that is not found exactly once is refused rather than guessed at.

import { logEvent } from "@dustinedwards/site-runtime/log";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiSettings, docActions, docChanges, docLocks, manuscripts } from "~/db/schema";
import { AiRefusal, emailDustin, type AiSession } from "~/lib/ai.server";
import { carrelOrigin } from "~/lib/mcp/server";
import type { Viewer } from "~/lib/people.server";

import { saClient, type DocWrite } from "./service-account.server";

type Fetch = typeof fetch;

const DOCS = "https://docs.googleapis.com/v1/documents";
export const GOOGLE_DOC = "application/vnd.google-apps.document";
/** The most text one read returns, in characters; a longer Doc is read by tab or by heading. */
const READ_LIMIT = 100_000;
const MAX = { quote: 2000, text: 20_000, reason: 1000, label: 1800, edits: 50, ids: 100 } as const;
/** The words kept on each side of a direct write, so undo finds the passage again. */
const CONTEXT = 40;
/** The most of a Doc's text kept from before a direct write; a longer Doc keeps the tab the write touched. */
const BEFORE_LIMIT = 1_000_000;
/** A stand-in for each character position taken by something that is not text (an image, a page break). */
const OBJECT = "￼";

/** Docs is the Owner's alone, as the manuscripts are (design section 3, "Roles"). */
function requireOwner(viewer: Viewer): void {
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
}

// ---------- what Google returns, as far as Carrel reads it

type Run = {
  content?: string;
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
};
type ParagraphElement = { startIndex?: number; endIndex?: number; textRun?: Run } & Record<
  string,
  unknown
>;
type Content = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: ParagraphElement[];
    paragraphStyle?: { namedStyleType?: string };
  };
  table?: { tableRows?: { tableCells?: { content?: Content[] }[] }[] };
  tableOfContents?: { content?: Content[] };
};
type Tab = {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: { body?: { content?: Content[] } };
  childTabs?: Tab[];
};
type Post = {
  postId?: string;
  content?: string;
  author?: { displayName?: string; me?: boolean };
  createTime?: string;
  deleted?: boolean;
  commentAction?: string;
  suggestionAction?: string;
};
type Thread = {
  commentId?: string;
  suggestionId?: string;
  headPost?: Post;
  replies?: Post[];
  status?: string;
  plainTextQuote?: string;
  summaryText?: string;
};
type GoogleDoc = {
  documentId: string;
  title: string;
  revisionId?: string;
  tabs?: Tab[];
  comments?: Thread[];
  suggestions?: Thread[];
};

// ---------- text with positions

type Seg = {
  start: number;
  end: number;
  text: string;
  state: "plain" | "inserted" | "deleted" | "object";
};
/** One paragraph (or table cell paragraph): its pieces in order, each with the positions Google gave it. */
type Para = { tabId: string; tabTitle: string; heading: number; segs: Seg[] };

function segmentOf(el: ParagraphElement): Seg | null {
  if (el.startIndex === undefined || el.endIndex === undefined) return null;
  const run = el.textRun;
  if (!run || run.content === undefined)
    return {
      start: el.startIndex,
      end: el.endIndex,
      text: OBJECT.repeat(el.endIndex - el.startIndex),
      state: "object",
    };
  const state = run.suggestedInsertionIds?.length
    ? "inserted"
    : run.suggestedDeletionIds?.length
      ? "deleted"
      : "plain";
  return { start: el.startIndex, end: el.endIndex, text: run.content, state };
}

function headingOf(style?: string): number {
  const m = /^HEADING_(\d)$/.exec(style ?? "");
  return m ? Number(m[1]) : style === "TITLE" ? 1 : 0;
}

function collect(
  content: Content[] | undefined,
  tab: { id: string; title: string },
  out: Para[],
): void {
  for (const c of content ?? []) {
    if (c.paragraph) {
      const segs = (c.paragraph.elements ?? []).map(segmentOf).filter((s): s is Seg => s !== null);
      out.push({
        tabId: tab.id,
        tabTitle: tab.title,
        heading: headingOf(c.paragraph.paragraphStyle?.namedStyleType),
        segs,
      });
    } else if (c.table) {
      for (const row of c.table.tableRows ?? [])
        for (const cell of row.tableCells ?? []) collect(cell.content, tab, out);
    } else if (c.tableOfContents) collect(c.tableOfContents.content, tab, out);
  }
}

/** Every paragraph of every tab, child tabs after their parent, in reading order. */
function paragraphsOf(doc: GoogleDoc): Para[] {
  const out: Para[] = [];
  const walk = (tabs: Tab[] | undefined) => {
    for (const tab of tabs ?? []) {
      const id = tab.tabProperties?.tabId ?? "";
      collect(tab.documentTab?.body?.content, { id, title: tab.tabProperties?.title ?? "" }, out);
      walk(tab.childTabs);
    }
  };
  walk(doc.tabs);
  return out;
}

/** A paragraph as an AI reads it: a pending insertion in {+ +}, a pending deletion in [- -], no final newline. */
function paraText(p: Para): string {
  const text = p.segs
    .map((s) =>
      s.state === "inserted" ? `{+${s.text}+}` : s.state === "deleted" ? `[-${s.text}-]` : s.text,
    )
    .join("");
  return text.replace(/\n$/, "");
}

// ---------- fetching

type Posts = { author: string; at: string | null; text: string; action?: string }[];

function postsOf(t: Thread): Posts {
  return [t.headPost, ...(t.replies ?? [])]
    .filter((p): p is Post => !!p && !p.deleted)
    .map((p) => ({
      author: p.author?.displayName ?? "unknown",
      at: p.createTime ?? null,
      text: p.content ?? "",
      ...((p.commentAction && p.commentAction !== "NO_COMMENT_ACTION_CHANGE") ||
      (p.suggestionAction && p.suggestionAction !== "NO_SUGGESTION_ACTION_CHANGE")
        ? { action: p.commentAction ?? p.suggestionAction }
        : {}),
    }));
}

async function googleError(res: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ? `: ${body.error.message}` : "";
  } catch {
    /* no body */
  }
  if (res.status === 403 || res.status === 404)
    throw new AiRefusal(
      `Google would not ${what} (${res.status}${detail}). The Doc must be shared with Carrel's service account as an Editor.`,
    );
  throw new AiRefusal(`Google did not ${what} (${res.status}${detail}).`);
}

export type DocLock = "suggest-only" | "no-ai";
/** What a call does to a Doc: read or suggest (allowed unless locked "no AI"), or change its text directly. */
type Need = "read" | "suggest" | "write";

/**
 * The index's row for a Doc, once the lock allows what the call needs: only a Google Doc in the shared folder is
 * reachable, never one Dustin locked "no AI", and a direct change never one he locked "suggest only".
 */
async function indexed(env: Env, viewer: Viewer, docId: string, need: Need = "read") {
  requireOwner(viewer);
  const lock = await drizzle(env.DB)
    .select({ lock: docLocks.lock })
    .from(docLocks)
    .where(eq(docLocks.fileId, docId))
    .get();
  if (lock?.lock === "no-ai")
    throw new AiRefusal("Dustin locked this Doc against AI in Carrel: no AI reads or changes it.");
  if (lock?.lock === "suggest-only" && need === "write")
    throw new AiRefusal(
      "Dustin locked this Doc to suggestions only: no direct write or accept. Suggest the change instead.",
    );
  const row = await drizzle(env.DB)
    .select()
    .from(manuscripts)
    .where(and(eq(manuscripts.fileId, docId), eq(manuscripts.mimeType, GOOGLE_DOC)))
    .get();
  if (!row)
    throw new AiRefusal(
      "That is not a Google Doc in the manuscripts index. List them with carrel_list_docs (refresh: true if it was added a moment ago).",
    );
  return row;
}

async function fetchDoc(env: Env, docId: string, fetcher?: Fetch): Promise<GoogleDoc> {
  const params = new URLSearchParams({
    includeTabsContent: "true",
    suggestionsViewMode: "SUGGESTIONS_INLINE",
    commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
  });
  const res = await saClient(env, fetcher).request("GET", `${DOCS}/${docId}?${params}`);
  if (!res.ok) return googleError(res, "read the Doc");
  return (await res.json()) as GoogleDoc;
}

// ---------- slice 1: read

type DocRead = {
  docId: string;
  title: string;
  url: string;
  revisionId: string | null;
  tabs: { tabId: string; title: string; paragraphs: number; chars: number }[];
  /** The text read, with `{+inserted+}` and `[-deleted-]` marking what a pending suggestion would change. */
  text: string;
  truncated: boolean;
  suggestions: { id: string; status: string; summary: string; posts: Posts }[];
  comments: { id: string; status: string; quote: string; posts: Posts }[];
};

export async function readGoogleDoc(
  env: Env,
  viewer: Viewer,
  docId: string,
  opts: { tab?: string; heading?: string } = {},
  fetcher?: Fetch,
): Promise<DocRead> {
  const row = await indexed(env, viewer, docId);
  const doc = await fetchDoc(env, docId, fetcher);
  const all = paragraphsOf(doc);
  const tabs = [...new Map(all.map((p) => [p.tabId, p.tabTitle])).entries()].map(
    ([tabId, title]) => ({
      tabId,
      title,
    }),
  );
  let chosen = all;
  if (opts.tab) {
    const wanted = opts.tab.trim().toLowerCase();
    const tab = tabs.find((t) => t.tabId === opts.tab || t.title.toLowerCase() === wanted);
    if (!tab)
      throw new AiRefusal(
        `This Doc has no tab ${opts.tab}. Its tabs: ${tabs.map((t) => `${t.title} (${t.tabId})`).join(", ")}.`,
      );
    chosen = all.filter((p) => p.tabId === tab.tabId);
  }
  if (opts.heading) {
    const wanted = opts.heading.trim().toLowerCase();
    const at = chosen.findIndex(
      (p) => p.heading > 0 && paraText(p).trim().toLowerCase() === wanted,
    );
    if (at < 0) throw new AiRefusal(`No heading reads "${opts.heading}" in what was asked for.`);
    const level = chosen[at]!.heading;
    let end = chosen.findIndex((p, i) => i > at && p.heading > 0 && p.heading <= level);
    if (end < 0) end = chosen.length;
    chosen = chosen.slice(at, end);
  }
  const full = chosen.map(paraText).join("\n");
  return {
    docId,
    title: row.name || doc.title,
    url: row.webViewLink,
    revisionId: doc.revisionId ?? null,
    tabs: tabs.map((t) => {
      const own = all.filter((p) => p.tabId === t.tabId);
      return {
        ...t,
        paragraphs: own.length,
        chars: own.reduce((n, p) => n + paraText(p).length + 1, 0),
      };
    }),
    text: full.slice(0, READ_LIMIT),
    truncated: full.length > READ_LIMIT,
    suggestions: (doc.suggestions ?? []).map((t) => ({
      id: t.suggestionId ?? "",
      status: t.status ?? "OPEN",
      summary: t.summaryText ?? "",
      posts: postsOf(t),
    })),
    comments: (doc.comments ?? []).map((t) => ({
      id: t.commentId ?? "",
      status: t.status ?? "OPEN",
      quote: t.plainTextQuote ?? "",
      posts: postsOf(t),
    })),
  };
}

// ---------- slice 2: suggest and comment

export type EditAsked =
  | { find: string; replace: string; reason?: string }
  | { insert_after: string; text: string; reason?: string };

/** Where a quote sits, with up to CONTEXT characters of plain text on each side in its paragraph. */
type Located = { start: number; end: number; tabId: string; prefix: string; suffix: string };

/** Where a quote sits: exactly once among the text no pending suggestion touches, inside one paragraph. */
function locate(paras: Para[], quote: string, tabId: string | undefined, what: string): Located {
  if (!quote) throw new AiRefusal(`${what} is empty.`);
  if (quote.length > MAX.quote)
    throw new AiRefusal(`${what} is longer than ${MAX.quote} characters.`);
  if (quote.includes("\n"))
    throw new AiRefusal(`${what} spans paragraphs. Quote one paragraph's words.`);
  const hits: Located[] = [];
  for (const p of paras) {
    if (tabId && p.tabId !== tabId) continue;
    // Runs of plain text that sit next to each other are one span; a pending suggestion ends it.
    let span: { start: number; end: number; text: string } | null = null;
    const flush = () => {
      if (!span) return;
      // The paragraph's closing newline is not text a quote may take.
      const text = span.text.endsWith("\n") ? span.text.slice(0, -1) : span.text;
      for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1))
        hits.push({
          start: span.start + at,
          end: span.start + at + quote.length,
          tabId: p.tabId,
          prefix: text.slice(Math.max(0, at - CONTEXT), at),
          suffix: text.slice(at + quote.length, at + quote.length + CONTEXT),
        });
      span = null;
    };
    for (const s of p.segs) {
      if (s.state !== "plain") flush();
      else if (span && span.end === s.start) {
        span.end = s.end;
        span.text += s.text;
      } else {
        flush();
        span = { start: s.start, end: s.end, text: s.text };
      }
    }
    flush();
  }
  if (hits.length === 0)
    throw new AiRefusal(
      `${what} ("${quote.slice(0, 80)}") is not in the Doc as plain text. It may sit inside a pending suggestion, span two paragraphs, or differ in spacing or quotes. Read the Doc again and copy the words exactly.`,
    );
  if (hits.length > 1)
    throw new AiRefusal(
      `${what} ("${quote.slice(0, 80)}") appears ${hits.length} times. Quote more of the sentence so it appears once.`,
    );
  return hits[0]!;
}

function tabIdOf(doc: GoogleDoc, tab: string | undefined): string | undefined {
  if (!tab) return undefined;
  const paras = paragraphsOf(doc);
  const wanted = tab.trim().toLowerCase();
  const found = paras.find((p) => p.tabId === tab || p.tabTitle.toLowerCase() === wanted);
  if (!found) throw new AiRefusal(`This Doc has no tab ${tab}.`);
  return found.tabId;
}

/** "Claude (Opus 5.5), through Carrel: tightened for length": which AI, and why. */
function labelOf(session: AiSession, model: string | undefined, said: string): string {
  const who = model?.trim() ? `${session.client} (${model.trim().slice(0, 60)})` : session.client;
  const why = said.trim().slice(0, MAX.label);
  return why ? `${who}, through Carrel: ${why}` : `${who}, through Carrel`;
}

async function batch(
  env: Env,
  docId: string,
  body: Record<string, unknown>,
  fetcher?: Fetch,
  opts: DocWrite = {},
): Promise<{
  suggestionResponses?: { createdSuggestionIds?: string[] }[];
  replies?: { insertComment?: { commentId?: string }; addCommentReply?: { postId?: string } }[];
  commentUpdateState?: string;
  writeControl?: { requiredRevisionId?: string };
}> {
  const res = await saClient(env, fetcher).request(
    "POST",
    `${DOCS}/${docId}:batchUpdate`,
    body,
    opts,
  );
  if (!res.ok) return googleError(res, "apply the change");
  return (await res.json()) as Awaited<ReturnType<typeof batch>>;
}

async function record(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  row: {
    fileId: string;
    mode: "suggest" | "comment" | "reply" | "resolve" | "reopen";
    model?: string;
    reason: string;
    change: unknown;
    googleIds: string[];
    labeled: boolean;
    revisionId?: string;
  },
): Promise<number> {
  const saved = await drizzle(env.DB)
    .insert(docChanges)
    .values({
      fileId: row.fileId,
      personId: viewer.id,
      client: session.client,
      model: row.model?.trim() || null,
      mode: row.mode,
      reason: row.reason.slice(0, MAX.reason),
      change: JSON.stringify(row.change),
      googleIds: JSON.stringify(row.googleIds),
      labeled: row.labeled,
      revisionId: row.revisionId ?? null,
    })
    .returning({ id: docChanges.id })
    .get();
  return saved.id;
}

type Planned = { at: Located; insert: string; remove: boolean; quote: string; reason: string };

/** Each edit as asked, located from one fresh read: refused whole if any quote is missing, repeated or overlapping. */
function planEdits(paras: Para[], edits: EditAsked[], tabId: string | undefined): Planned[] {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > MAX.edits)
    throw new AiRefusal(`edits is a list of 1 to ${MAX.edits} edits.`);
  const planned = edits.map((edit, i): Planned => {
    const n = `Edit ${i + 1}`;
    if ("find" in edit) {
      if (typeof edit.replace !== "string" || edit.replace.length > MAX.text)
        throw new AiRefusal(
          `${n}: replace is text of at most ${MAX.text} characters ("" deletes).`,
        );
      const at = locate(paras, edit.find, tabId, `${n}: find`);
      return {
        at,
        insert: edit.replace,
        remove: true,
        quote: edit.find,
        reason: edit.reason ?? "",
      };
    }
    if (
      typeof edit.insert_after !== "string" ||
      typeof edit.text !== "string" ||
      !edit.text ||
      edit.text.length > MAX.text
    )
      throw new AiRefusal(
        `${n}: an insertion has insert_after (a quote) and text (1 to ${MAX.text} characters).`,
      );
    const at = locate(paras, edit.insert_after, tabId, `${n}: insert_after`);
    return {
      at,
      insert: edit.text,
      remove: false,
      quote: edit.insert_after,
      reason: edit.reason ?? "",
    };
  });
  // Edits may not touch each other: two changes to the same words would be ambiguous.
  const byStart = [...planned].sort((x, y) => x.at.start - y.at.start);
  for (let i = 1; i < byStart.length; i++)
    if (
      byStart[i]!.at.tabId === byStart[i - 1]!.at.tabId &&
      byStart[i]!.at.start < byStart[i - 1]!.at.end
    )
      throw new AiRefusal("Two edits quote overlapping words. Merge them into one edit.");
  return planned;
}

/** The batch's requests, last position first, so an earlier edit's text does not move a later one's positions. */
function requestsOf(planned: Planned[]): { requests: Record<string, unknown>[]; owner: number[] } {
  const requests: Record<string, unknown>[] = [];
  const owner: number[] = [];
  for (const e of [...planned].sort((x, y) => y.at.start - x.at.start)) {
    const index = planned.indexOf(e);
    if (e.insert) {
      requests.push({
        insertText: { text: e.insert, location: { index: e.at.end, tabId: e.at.tabId } },
      });
      owner.push(index);
    }
    if (e.remove) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: e.at.start, endIndex: e.at.end, tabId: e.at.tabId },
        },
      });
      owner.push(index);
    }
  }
  return { requests, owner };
}

type SuggestResult = {
  mode: "suggest";
  changeId: number;
  /** Give this to carrel_undo_doc to take the change back. */
  undo: string;
  suggestionIds: string[];
  edits: number;
  /** The label is on every suggestion in the Doc. When false, `labelProblem` says why; the change itself is in. */
  labeled: boolean;
  labelProblem?: string;
};

type WriteResult = {
  mode: "write";
  changeId: number;
  undo: string;
  edits: number;
  /** Whether Dustin was emailed now; "daily" or "off" by his Docs email setting. */
  emailed: boolean | "daily" | "off";
};

/**
 * Changes a Doc's text: as suggestions, each labeled with the AI and the reason, or, when the call asks for it, a
 * direct write. A direct write is the Owner's own ask, refused on a Doc locked "suggest only"; it keeps the text it
 * replaced and the Doc's text before it, and emails Dustin by his Docs email setting.
 */
export async function changeInDoc(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: {
    edits: EditAsked[];
    reason: string;
    tab?: string;
    model?: string;
    mode?: "suggest" | "write";
  },
  fetcher?: Fetch,
): Promise<SuggestResult | WriteResult> {
  const write = input.mode === "write";
  const row = await indexed(env, viewer, docId, write ? "write" : "suggest");
  const doc = await fetchDoc(env, docId, fetcher);
  const paras = paragraphsOf(doc);
  const planned = planEdits(paras, input.edits, tabIdOf(doc, input.tab));
  const { requests, owner } = requestsOf(planned);
  if (write) {
    const touched = new Set(planned.map((p) => p.at.tabId));
    const all = paras.map(paraText).join("\n");
    const beforeText =
      all.length <= BEFORE_LIMIT
        ? all
        : paras
            .filter((p) => touched.has(p.tabId))
            .map(paraText)
            .join("\n")
            .slice(0, BEFORE_LIMIT);
    await batch(
      env,
      docId,
      { requests, writeControl: { requiredRevisionId: doc.revisionId } },
      fetcher,
      { direct: true },
    );
    return writeDone(env, viewer, session, row, {
      model: input.model,
      reason: input.reason,
      edits: planned,
      revisionId: doc.revisionId,
      beforeText,
    });
  }
  const done = await batch(
    env,
    docId,
    { requests, writeControl: { writeMode: "SUGGEST", requiredRevisionId: doc.revisionId } },
    fetcher,
  );
  const ids = new Set<string>();
  const reasonsOf = new Map<string, Set<string>>();
  (done.suggestionResponses ?? []).forEach((r, i) => {
    for (const id of r.createdSuggestionIds ?? []) {
      ids.add(id);
      const why = planned[owner[i] ?? 0]?.reason.trim();
      const set = reasonsOf.get(id) ?? new Set<string>();
      if (why) set.add(why);
      reasonsOf.set(id, set);
    }
  });
  let labelProblem: string | undefined;
  if (done.commentUpdateState === "ALL_FAILED_UNKNOWN_REASON")
    labelProblem =
      "Google saved the text changes but not their suggestion records, so they may not show as suggestions.";
  else if (ids.size === 0)
    labelProblem = "Google returned no suggestion ids, so nothing could be labeled.";
  else {
    try {
      const labeled = await batch(
        env,
        docId,
        {
          requests: [...ids].map((id) => ({
            addCommentReply: {
              suggestionId: id,
              post: {
                content: labelOf(
                  session,
                  input.model,
                  [...(reasonsOf.get(id) ?? [])].join("; ") || input.reason,
                ),
              },
            },
          })),
        },
        fetcher,
      );
      if (labeled.commentUpdateState === "ALL_FAILED_UNKNOWN_REASON")
        labelProblem = "Google did not save the labels on the suggestions.";
    } catch (error) {
      labelProblem = error instanceof AiRefusal ? error.message : "The labels could not be added.";
    }
  }
  const changeId = await record(env, viewer, session, {
    fileId: docId,
    mode: "suggest",
    model: input.model,
    reason: input.reason,
    change: planned.map((p) => ({
      tab: p.at.tabId,
      start: p.at.start,
      end: p.at.end,
      remove: p.remove,
      insert: p.insert,
      reason: p.reason,
    })),
    googleIds: [...ids],
    labeled: labelProblem === undefined,
    revisionId: doc.revisionId,
  });
  return {
    mode: "suggest",
    changeId,
    undo: `c${changeId}`,
    suggestionIds: [...ids],
    edits: planned.length,
    labeled: labelProblem === undefined,
    ...(labelProblem ? { labelProblem } : {}),
  };
}

/** One direct write's edit as kept for undo: the text before and after, and the words on each side. */
type WrittenEdit = { tab: string; before: string; after: string; prefix: string; suffix: string };

function writtenOf(p: Planned): WrittenEdit {
  // An insertion keeps its quote as part of the words before it, so undo finds the spot again.
  return p.remove
    ? {
        tab: p.at.tabId,
        before: p.quote,
        after: p.insert,
        prefix: p.at.prefix,
        suffix: p.at.suffix,
      }
    : {
        tab: p.at.tabId,
        before: "",
        after: p.insert,
        prefix: (p.at.prefix + p.quote).slice(-CONTEXT),
        suffix: p.at.suffix,
      };
}

/** Records a direct write (or the undo of one) and emails Dustin about it by his Docs email setting. */
async function writeDone(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  row: { fileId: string; name: string; webViewLink: string },
  w: {
    model?: string;
    reason: string;
    edits: Planned[] | WrittenEdit[];
    revisionId?: string;
    beforeText?: string;
    undoes?: { id: number; table: "doc_changes" | "doc_actions" };
  },
): Promise<WriteResult> {
  const edits = w.edits.map((e) => ("at" in e ? writtenOf(e) : e));
  const actionId = await recordAction(env, viewer, session, {
    fileId: row.fileId,
    action: w.undoes ? "undo" : "write",
    model: w.model,
    reason: w.reason,
    change: edits,
    revisionId: w.revisionId,
    beforeText: w.beforeText,
    undoes: w.undoes,
  });
  const setting = await readDocsEmail(env.DB);
  let emailed: WriteResult["emailed"] = setting === "each" ? false : setting;
  if (setting === "each") {
    const verb = w.undoes ? "took back a direct write in" : "wrote directly in";
    emailed = await emailWrites(env, [actionId], {
      subject: `Carrel: ${session.client} ${verb} "${row.name}"`,
      text: [
        `${labelOf(session, w.model, w.reason)}`,
        "",
        `${row.name}: ${row.webViewLink}`,
        "",
        ...edits.flatMap((e, i) => [
          `Edit ${i + 1}:`,
          `  before: ${e.before || "(nothing)"}`,
          `  after:  ${e.after || "(deleted)"}`,
        ]),
        "",
        `Take it back: ask any AI connected to Carrel to undo a${actionId} in this Doc, or open ${carrelOrigin(env)}/manuscripts/activity.`,
        "",
      ].join("\n"),
    });
  }
  return { mode: "write", changeId: actionId, undo: `a${actionId}`, edits: edits.length, emailed };
}

/** Sends one email about these doc_actions rows and records on each whether it went. */
async function emailWrites(
  env: Env,
  ids: number[],
  mail: { subject: string; text: string },
): Promise<boolean> {
  const d = drizzle(env.DB);
  const error = await emailDustin(env, mail);
  if (error) {
    logEvent("docs.email-failed", { ids: ids.join(","), error }, { level: "error" });
    await d.update(docActions).set({ emailError: error }).where(inArray(docActions.id, ids));
    return false;
  }
  await d
    .update(docActions)
    .set({ emailedAt: new Date().toISOString() })
    .where(inArray(docActions.id, ids));
  return true;
}

// ---------- the Docs email setting: each direct write, a daily summary, or off (on, each, until Dustin changes it)

const DOCS_EMAIL = ["each", "daily", "off"] as const;
export type DocsEmail = (typeof DOCS_EMAIL)[number];

/** The Docs email setting, kept in the AI settings row beside the engine settings. */
export async function readDocsEmail(db: D1Database): Promise<DocsEmail> {
  const row = await drizzle(db).select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  try {
    const value = row ? (JSON.parse(row.json) as { docsEmail?: unknown }).docsEmail : undefined;
    return DOCS_EMAIL.includes(value as DocsEmail) ? (value as DocsEmail) : "each";
  } catch {
    return "each";
  }
}

export async function saveDocsEmail(db: D1Database, viewer: Viewer, value: string): Promise<void> {
  requireOwner(viewer);
  if (!DOCS_EMAIL.includes(value as DocsEmail)) throw new Response("Bad request", { status: 400 });
  const row = await drizzle(db).select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  let saved: Record<string, unknown> = {};
  try {
    saved = row ? (JSON.parse(row.json) as Record<string, unknown>) : {};
  } catch {
    /* an unreadable row starts over, as readAiSettings does */
  }
  const json = JSON.stringify({ ...saved, docsEmail: value });
  await drizzle(db)
    .insert(aiSettings)
    .values({ id: 1, json })
    .onConflictDoUpdate({ target: aiSettings.id, set: { json } });
}

/**
 * The nightly summary when the setting is "daily": one email listing the direct writes of the last two days that no
 * email has covered. Nothing to say sends nothing.
 */
export async function emailDocsDigest(env: Env, now = new Date()): Promise<{ sent: number }> {
  if ((await readDocsEmail(env.DB)) !== "daily") return { sent: 0 };
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const rows = await drizzle(env.DB)
    .select({
      id: docActions.id,
      client: docActions.client,
      action: docActions.action,
      reason: docActions.reason,
      createdAt: docActions.createdAt,
      name: manuscripts.name,
      link: manuscripts.webViewLink,
    })
    .from(docActions)
    .leftJoin(manuscripts, eq(manuscripts.fileId, docActions.fileId))
    .where(
      and(
        inArray(docActions.action, ["write", "undo"]),
        isNull(docActions.emailedAt),
        gte(docActions.createdAt, since),
      ),
    )
    .orderBy(docActions.id)
    .all();
  if (rows.length === 0) return { sent: 0 };
  await emailWrites(
    env,
    rows.map((r) => r.id),
    {
      subject: `Carrel: ${rows.length} direct write${rows.length === 1 ? "" : "s"} in your Google Docs`,
      text: [
        ...rows.map(
          (r) =>
            `a${r.id} ${r.createdAt.slice(0, 16).replace("T", " ")} UTC: ${r.client} ${r.action === "undo" ? "took back a write" : "wrote"} in ${r.name ?? "a Doc"}: ${r.reason}${r.link ? ` (${r.link})` : ""}`,
        ),
        "",
        `Take one back: ask any AI connected to Carrel to undo it by its id, or open ${carrelOrigin(env)}/manuscripts/activity.`,
        "",
      ].join("\n"),
    },
  );
  return { sent: rows.length };
}

async function recordAction(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  row: {
    fileId: string;
    action: "write" | "accept" | "reject" | "withdraw" | "undo";
    model?: string;
    reason: string;
    change: unknown;
    googleIds?: string[];
    revisionId?: string;
    beforeText?: string;
    undoes?: { id: number; table: "doc_changes" | "doc_actions" };
  },
): Promise<number> {
  const d = drizzle(env.DB);
  const saved = await d
    .insert(docActions)
    .values({
      fileId: row.fileId,
      personId: viewer.id,
      client: session.client,
      model: row.model?.trim() || null,
      action: row.action,
      reason: row.reason.slice(0, MAX.reason),
      change: JSON.stringify(row.change),
      googleIds: JSON.stringify(row.googleIds ?? []),
      revisionId: row.revisionId ?? null,
      beforeText: row.beforeText ?? null,
      undoes: row.undoes?.id ?? null,
      undoesTable: row.undoes?.table ?? null,
    })
    .returning({ id: docActions.id })
    .get();
  if (row.undoes) {
    const at = new Date().toISOString();
    if (row.undoes.table === "doc_changes")
      await d.update(docChanges).set({ undoneAt: at }).where(eq(docChanges.id, row.undoes.id));
    else await d.update(docActions).set({ undoneAt: at }).where(eq(docActions.id, row.undoes.id));
  }
  return saved.id;
}

// ---------- slice 3: review (accept, reject, withdraw) and undo

const REVIEW = {
  accept: "acceptSuggestion",
  reject: "rejectSuggestion",
  withdraw: "deleteSuggestion",
} as const;
export type ReviewAction = keyof typeof REVIEW;

/** The suggestion ids Carrel laid in this Doc, by the AI that asked for each. */
async function carrelSuggestions(env: Env, docId: string) {
  const rows = await drizzle(env.DB)
    .select({ client: docChanges.client, googleIds: docChanges.googleIds })
    .from(docChanges)
    .where(and(eq(docChanges.fileId, docId), eq(docChanges.mode, "suggest")))
    .all();
  return rows.flatMap((r) =>
    (JSON.parse(r.googleIds) as string[]).map((id) => ({ id, client: r.client })),
  );
}

/**
 * Accepts, rejects or withdraws open suggestions, named by id or as "every open one this AI made" (`by`). Accepting
 * is a direct change to the text, so it is refused on a Doc locked "suggest only"; withdrawing takes back only the
 * calling AI's own suggestions, as Google lets only a suggestion's author delete it.
 */
export async function reviewInDoc(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: {
    action: ReviewAction;
    suggestions?: string[];
    by?: string;
    reason?: string;
    model?: string;
  },
  fetcher?: Fetch,
): Promise<{ changeId: number; action: ReviewAction; suggestionIds: string[] }> {
  const request = REVIEW[input.action];
  if (!request) throw new AiRefusal("action is accept, reject or withdraw.");
  await indexed(env, viewer, docId, input.action === "accept" ? "write" : "suggest");
  const named = input.suggestions?.filter(Boolean) ?? [];
  if (named.length > 0 === Boolean(input.by?.trim()))
    throw new AiRefusal(
      "Name the suggestions (suggestions) or the AI whose open ones to take (by), not both.",
    );
  if (named.length > MAX.ids) throw new AiRefusal(`suggestions holds at most ${MAX.ids} ids.`);
  const doc = await fetchDoc(env, docId, fetcher);
  const open = new Set(
    (doc.suggestions ?? [])
      .filter((t) => (t.status ?? "OPEN") === "OPEN" && t.suggestionId)
      .map((t) => t.suggestionId!),
  );
  const ours = await carrelSuggestions(env, docId);
  const ids = named.length
    ? named
    : [
        ...new Set(
          ours
            .filter((o) => o.client.toLowerCase() === input.by!.trim().toLowerCase())
            .map((o) => o.id),
        ),
      ].filter((id) => open.has(id));
  if (ids.length === 0) throw new AiRefusal(`${input.by} has no open suggestion in this Doc.`);
  const closed = ids.filter((id) => !open.has(id));
  if (closed.length)
    throw new AiRefusal(
      `Not an open suggestion in this Doc: ${closed.join(", ")}. Read the Doc again for the open ones.`,
    );
  if (input.action === "withdraw") {
    const own = new Set(ours.filter((o) => o.client === session.client).map((o) => o.id));
    const others = ids.filter((id) => !own.has(id));
    if (others.length)
      throw new AiRefusal(
        `Withdraw takes back only ${session.client}'s own suggestions through Carrel; these are not: ${others.join(", ")}. Reject them instead.`,
      );
  }
  await batch(
    env,
    docId,
    { requests: ids.map((id) => ({ [request]: { suggestionId: id } })) },
    fetcher,
    { direct: input.action === "accept" },
  );
  const changeId = await recordAction(env, viewer, session, {
    fileId: docId,
    action: input.action,
    model: input.model,
    reason: input.reason?.trim() || `${input.action} ${ids.length}`,
    change: { suggestions: ids, by: input.by ?? null },
    googleIds: ids,
    revisionId: doc.revisionId,
  });
  return { changeId, action: input.action, suggestionIds: ids };
}

/** Everything Carrel changed in one Doc, newest first, each with the id carrel_undo_doc takes. */
export async function docHistory(env: Env, viewer: Viewer, docId: string, limit = 50) {
  await indexed(env, viewer, docId);
  const d = drizzle(env.DB);
  const [changes, actions] = await Promise.all([
    d
      .select()
      .from(docChanges)
      .where(eq(docChanges.fileId, docId))
      .orderBy(desc(docChanges.id))
      .limit(limit)
      .all(),
    d
      .select()
      .from(docActions)
      .where(eq(docActions.fileId, docId))
      .orderBy(desc(docActions.id))
      .limit(limit)
      .all(),
  ]);
  return [
    ...changes.map((c) => ({
      undo: `c${c.id}`,
      what: c.mode,
      client: c.client,
      model: c.model,
      reason: c.reason,
      googleIds: JSON.parse(c.googleIds) as string[],
      at: c.createdAt,
      undoneAt: c.undoneAt,
    })),
    ...actions.map((a) => ({
      undo: `a${a.id}`,
      what: a.action,
      client: a.client,
      model: a.model,
      reason: a.reason,
      googleIds: JSON.parse(a.googleIds) as string[],
      at: a.createdAt,
      undoneAt: a.undoneAt,
    })),
  ]
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, limit);
}

/**
 * Takes one change back. A suggestion is withdrawn (those still open), a comment thread is deleted, and a direct write
 * puts the old text back where the written text still stands, word for word with the words around it. If it moved or
 * changed, nothing is written and the answer shows what it was, beside the Doc's text before the write.
 */
export async function undoInDoc(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: { change: string; reason?: string; model?: string },
  fetcher?: Fetch,
): Promise<
  | SuggestResult
  | WriteResult
  | { mode: "withdraw" | "delete-comment"; changeId: number; undone: string[] }
> {
  const row = await indexed(env, viewer, docId, "suggest");
  const ref = /^([ca])(\d{1,12})$/.exec(input.change.trim());
  if (!ref) throw new AiRefusal("change is an id from carrel_undo_doc's list, such as c12 or a5.");
  const id = Number(ref[2]);
  const d = drizzle(env.DB);
  const reason = input.reason?.trim() || `undo ${input.change}`;
  if (ref[1] === "c") {
    const c = await d
      .select()
      .from(docChanges)
      .where(and(eq(docChanges.id, id), eq(docChanges.fileId, docId)))
      .get();
    if (!c) throw new AiRefusal(`There is no change ${input.change} in this Doc.`);
    if (c.undoneAt) throw new AiRefusal(`${input.change} was already taken back.`);
    const ids = JSON.parse(c.googleIds) as string[];
    if (c.mode === "suggest") {
      const doc = await fetchDoc(env, docId, fetcher);
      const open = new Set(
        (doc.suggestions ?? [])
          .filter((t) => (t.status ?? "OPEN") === "OPEN")
          .map((t) => t.suggestionId),
      );
      const still = ids.filter((s) => open.has(s));
      if (still.length === 0)
        throw new AiRefusal(
          `${input.change}'s suggestions are no longer open: Dustin accepted or rejected them in Docs. To change accepted text back, ask for a direct write.`,
        );
      await batch(
        env,
        docId,
        { requests: still.map((s) => ({ deleteSuggestion: { suggestionId: s } })) },
        fetcher,
      );
      const changeId = await recordAction(env, viewer, session, {
        fileId: docId,
        action: "undo",
        model: input.model,
        reason,
        change: { withdrew: still },
        googleIds: still,
        revisionId: doc.revisionId,
        undoes: { id, table: "doc_changes" },
      });
      return { mode: "withdraw", changeId, undone: still };
    }
    if (c.mode === "comment" && ids[0]) {
      await batch(env, docId, { requests: [{ deleteComment: { commentId: ids[0] } }] }, fetcher);
      const changeId = await recordAction(env, viewer, session, {
        fileId: docId,
        action: "undo",
        model: input.model,
        reason,
        change: { deletedComment: ids[0] },
        googleIds: [ids[0]],
        undoes: { id, table: "doc_changes" },
      });
      return { mode: "delete-comment", changeId, undone: [ids[0]] };
    }
    throw new AiRefusal(
      c.mode === "resolve"
        ? "A resolve is taken back by reopening: carrel_comment_doc with action reopen."
        : `A ${c.mode} is not taken back here; reply on the thread instead.`,
    );
  }
  const a = await d
    .select()
    .from(docActions)
    .where(and(eq(docActions.id, id), eq(docActions.fileId, docId)))
    .get();
  if (!a) throw new AiRefusal(`There is no change ${input.change} in this Doc.`);
  if (a.undoneAt) throw new AiRefusal(`${input.change} was already taken back.`);
  if (a.action !== "write")
    throw new AiRefusal(
      a.action === "accept"
        ? "Accepted text is part of the Doc now. To change it back, ask for a direct write."
        : a.action === "undo"
          ? "An undo is not undone; ask for the change again."
          : "A rejected or withdrawn suggestion cannot be brought back; suggest it again.",
    );
  const written = JSON.parse(a.change) as WrittenEdit[];
  const doc = await fetchDoc(env, docId, fetcher);
  const paras = paragraphsOf(doc);
  const moved: string[] = [];
  const planned: Planned[] = [];
  for (const [i, e] of written.entries()) {
    const quote = e.prefix + e.after + e.suffix;
    try {
      const at = locate(paras, quote, e.tab, `Edit ${i + 1}`);
      const start = at.start + e.prefix.length;
      const end = start + e.after.length;
      planned.push({
        at: { ...at, start, end },
        insert: e.before,
        remove: e.after.length > 0,
        quote: e.after,
        reason: "",
      });
    } catch {
      moved.push(
        `Edit ${i + 1}: "${e.after || "(deleted text)"}" is no longer where it was written; it replaced "${e.before || "(nothing)"}".`,
      );
    }
  }
  if (moved.length)
    throw new AiRefusal(
      `Nothing was changed: the written text moved or was edited since. ${moved.join(" ")} The Doc's text before the write is kept in Carrel (doc_actions a${id}); Dustin can restore it by hand or from Docs' version history.`,
    );
  // An insertion that is now empty (it deleted text) puts the old text in at its spot, with nothing to remove.
  const { requests } = requestsOf(
    planned.map((p) => (p.remove ? p : { ...p, at: { ...p.at, end: p.at.start } })),
  );
  if (requests.length === 0) throw new AiRefusal("That write changed nothing to take back.");
  await batch(
    env,
    docId,
    { requests, writeControl: { requiredRevisionId: doc.revisionId } },
    fetcher,
    {
      direct: true,
    },
  );
  return writeDone(env, viewer, session, row, {
    model: input.model,
    reason,
    edits: planned.map((p, i) => ({
      tab: p.at.tabId,
      before: written[i]!.after,
      after: written[i]!.before,
      prefix: written[i]!.prefix,
      suffix: written[i]!.suffix,
    })),
    revisionId: doc.revisionId,
    undoes: { id, table: "doc_actions" },
  });
}

// ---------- the per-Doc lock, set on Desk's Manuscripts page

export async function readDocLocks(
  db: D1Database,
  viewer: Viewer,
): Promise<Record<string, DocLock>> {
  requireOwner(viewer);
  const rows = await drizzle(db).select().from(docLocks).all();
  return Object.fromEntries(rows.map((r) => [r.fileId, r.lock]));
}

/** Sets a Doc's lock, or clears it with "open". */
export async function setDocLock(db: D1Database, viewer: Viewer, fileId: string, lock: string) {
  requireOwner(viewer);
  const d = drizzle(db);
  if (lock === "open") {
    await d.delete(docLocks).where(eq(docLocks.fileId, fileId));
    return;
  }
  if (lock !== "suggest-only" && lock !== "no-ai")
    throw new Response("Bad request", { status: 400 });
  const at = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
  await d
    .insert(docLocks)
    .values({ fileId, lock })
    .onConflictDoUpdate({ target: docLocks.fileId, set: { lock, setAt: at } });
}

type CommentResult = { changeId: number; id: string | null; labeled: true };

/**
 * A comment on quoted words, a reply to a thread (a comment's or a suggestion's), or a resolve or reopen.
 * The label is the start of the post itself, so it cannot be saved without the words.
 */
export async function commentInDoc(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: {
    text?: string;
    quote?: string;
    reply_to?: string;
    action?: "resolve" | "reopen" | "";
    tab?: string;
    model?: string;
  },
  fetcher?: Fetch,
): Promise<CommentResult> {
  await indexed(env, viewer, docId, "suggest");
  const text = input.text?.trim() ?? "";
  if (text.length > 1800) throw new AiRefusal("text is longer than 1,800 characters.");
  if (input.action && !input.reply_to)
    throw new AiRefusal("resolve and reopen need reply_to, the comment's id.");
  if (!input.action && !text) throw new AiRefusal("text is required.");
  if (input.reply_to && input.quote)
    throw new AiRefusal("A reply goes on a thread; give reply_to or quote, not both.");
  if (!input.reply_to && !input.quote)
    throw new AiRefusal("A new comment needs quote, the words it is about.");
  const said = input.action ? text || (input.action === "resolve" ? "resolved" : "reopened") : text;
  const content = labelOf(session, input.model, said);
  let request: Record<string, unknown>;
  let revisionId: string | undefined;
  if (input.reply_to) {
    // A suggestion thread's id starts "suggest."; a comment's does not (Google's own ids).
    const key = input.reply_to.startsWith("suggest.") ? "suggestionId" : "commentId";
    request = {
      addCommentReply: {
        [key]: input.reply_to,
        post: {
          content,
          ...(input.action
            ? { commentAction: input.action === "resolve" ? "RESOLVE" : "REOPEN" }
            : {}),
        },
      },
    };
  } else {
    const doc = await fetchDoc(env, docId, fetcher);
    revisionId = doc.revisionId;
    const at = locate(paragraphsOf(doc), input.quote!, tabIdOf(doc, input.tab), "quote");
    request = {
      insertComment: {
        content,
        range: { startIndex: at.start, endIndex: at.end, tabId: at.tabId },
      },
    };
  }
  const done = await batch(env, docId, { requests: [request] }, fetcher);
  if (done.commentUpdateState === "ALL_FAILED_UNKNOWN_REASON")
    throw new AiRefusal("Google did not save the comment.");
  const reply = done.replies?.[0];
  const id = reply?.insertComment?.commentId ?? reply?.addCommentReply?.postId ?? null;
  const mode = input.action || (input.reply_to ? "reply" : "comment");
  const changeId = await record(env, viewer, session, {
    fileId: docId,
    mode,
    model: input.model,
    reason: text,
    change: { reply_to: input.reply_to ?? null, quote: input.quote ?? null, content },
    googleIds: id ? [id] : [],
    labeled: true,
    revisionId,
  });
  return { changeId, id, labeled: true };
}

/** The latest changes AIs made in Docs, newest first, with each Doc's name: the Docs activity page. */
export async function docActivity(env: Env, viewer: Viewer, limit = 100) {
  requireOwner(viewer);
  const d = drizzle(env.DB);
  const [changes, actions] = await Promise.all([
    d
      .select({
        id: docChanges.id,
        fileId: docChanges.fileId,
        name: manuscripts.name,
        link: manuscripts.webViewLink,
        client: docChanges.client,
        model: docChanges.model,
        mode: docChanges.mode,
        reason: docChanges.reason,
        googleIds: docChanges.googleIds,
        labeled: docChanges.labeled,
        undoneAt: docChanges.undoneAt,
        createdAt: docChanges.createdAt,
      })
      .from(docChanges)
      .leftJoin(manuscripts, eq(manuscripts.fileId, docChanges.fileId))
      .orderBy(desc(docChanges.id))
      .limit(limit)
      .all(),
    d
      .select({
        id: docActions.id,
        fileId: docActions.fileId,
        name: manuscripts.name,
        link: manuscripts.webViewLink,
        client: docActions.client,
        model: docActions.model,
        mode: docActions.action,
        reason: docActions.reason,
        googleIds: docActions.googleIds,
        change: docActions.change,
        undoneAt: docActions.undoneAt,
        createdAt: docActions.createdAt,
      })
      .from(docActions)
      .leftJoin(manuscripts, eq(manuscripts.fileId, docActions.fileId))
      .orderBy(desc(docActions.id))
      .limit(limit)
      .all(),
  ]);
  return [
    ...changes.map((r) => ({
      ...r,
      ref: `c${r.id}`,
      changes: (JSON.parse(r.googleIds) as string[]).length,
    })),
    ...actions.map(({ change, ...r }) => {
      const edits = JSON.parse(change) as unknown;
      return {
        ...r,
        ref: `a${r.id}`,
        // Labels are for suggestions and comments; a write is recorded and emailed instead.
        labeled: true,
        changes: Array.isArray(edits) ? edits.length : (JSON.parse(r.googleIds) as string[]).length,
      };
    }),
  ]
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    .slice(0, limit);
}
