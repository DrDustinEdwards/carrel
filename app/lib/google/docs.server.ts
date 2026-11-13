// Google Docs through the service account (the Docs plan, slices 1 and 2): read a Doc with its pending suggestions
// and its comments, lay edits in as suggestions, and comment. One path for every AI: the MCP tools call these
// functions and nothing else reaches a Doc. The rules live here and in service-account.server.ts:
//
// - Owner only, and only a Doc in the manuscripts index (the shared folder), so a Doc someone shared with the
//   robot elsewhere is out of reach.
// - A change to a Doc's text is a suggestion, never a direct write (the allowlist refuses anything else).
// - Every suggestion and comment says which AI made it and why, in the Doc itself, and every change is a row in
//   doc_changes.
// An AI names text by quoting it. Carrel turns the quote into Google's positions from a fresh read, so no AI does
// position arithmetic, and a quote that is not found exactly once is refused rather than guessed at.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { docChanges, manuscripts } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import type { Viewer } from "~/lib/people.server";

import { saClient } from "./service-account.server";

type Fetch = typeof fetch;

const DOCS = "https://docs.googleapis.com/v1/documents";
export const GOOGLE_DOC = "application/vnd.google-apps.document";
/** The most text one read returns, in characters; a longer Doc is read by tab or by heading. */
const READ_LIMIT = 100_000;
const MAX = { quote: 2000, text: 20_000, reason: 1000, label: 1800, edits: 50 } as const;
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

/** The index's row for a Doc: only a Google Doc in the shared folder is reachable. */
async function indexed(env: Env, viewer: Viewer, docId: string) {
  requireOwner(viewer);
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

type Located = { start: number; end: number; tabId: string };

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
        hits.push({ start: span.start + at, end: span.start + at + quote.length, tabId: p.tabId });
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
): Promise<{
  suggestionResponses?: { createdSuggestionIds?: string[] }[];
  replies?: { insertComment?: { commentId?: string }; addCommentReply?: { postId?: string } }[];
  commentUpdateState?: string;
  writeControl?: { requiredRevisionId?: string };
}> {
  const res = await saClient(env, fetcher).request("POST", `${DOCS}/${docId}:batchUpdate`, body);
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
    labelled: boolean;
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
      labelled: row.labelled,
      revisionId: row.revisionId ?? null,
    })
    .returning({ id: docChanges.id })
    .get();
  return saved.id;
}

type SuggestResult = {
  changeId: number;
  suggestionIds: string[];
  edits: number;
  /** The label is on every suggestion in the Doc. When false, `labelProblem` says why; the change itself is in. */
  labelled: boolean;
  labelProblem?: string;
};

/** Lays the edits in the Doc as suggestions, then puts the AI's label on each suggestion. */
export async function suggestInDoc(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: { edits: EditAsked[]; reason: string; tab?: string; model?: string },
  fetcher?: Fetch,
): Promise<SuggestResult> {
  await indexed(env, viewer, docId);
  if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > MAX.edits)
    throw new AiRefusal(`edits is a list of 1 to ${MAX.edits} edits.`);
  const doc = await fetchDoc(env, docId, fetcher);
  const paras = paragraphsOf(doc);
  const tabId = tabIdOf(doc, input.tab);
  const planned = input.edits.map((edit, i) => {
    const n = `Edit ${i + 1}`;
    if ("find" in edit) {
      if (typeof edit.replace !== "string" || edit.replace.length > MAX.text)
        throw new AiRefusal(
          `${n}: replace is text of at most ${MAX.text} characters ("" deletes).`,
        );
      const at = locate(paras, edit.find, tabId, `${n}: find`);
      return {
        at,
        insertAt: at.end,
        insert: edit.replace,
        remove: true,
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
    return { at, insertAt: at.end, insert: edit.text, remove: false, reason: edit.reason ?? "" };
  });
  // Edits may not touch each other: two suggestions on the same words would be ambiguous.
  const byStart = [...planned].sort((a, b) => a.at.start - b.at.start);
  for (let i = 1; i < byStart.length; i++)
    if (
      byStart[i]!.at.tabId === byStart[i - 1]!.at.tabId &&
      byStart[i]!.at.start < byStart[i - 1]!.at.end
    )
      throw new AiRefusal("Two edits quote overlapping words. Merge them into one edit.");
  // Last position first, so an earlier edit's text does not move a later one's positions.
  const order = [...planned].sort((a, b) => b.at.start - a.at.start);
  const requests: Record<string, unknown>[] = [];
  const owner: number[] = [];
  for (const e of order) {
    const index = planned.indexOf(e);
    if (e.insert) {
      requests.push({
        insertText: { text: e.insert, location: { index: e.insertAt, tabId: e.at.tabId } },
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
    labelProblem = "Google returned no suggestion ids, so nothing could be labelled.";
  else {
    try {
      const labelled = await batch(
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
      if (labelled.commentUpdateState === "ALL_FAILED_UNKNOWN_REASON")
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
    labelled: labelProblem === undefined,
    revisionId: doc.revisionId,
  });
  return {
    changeId,
    suggestionIds: [...ids],
    edits: planned.length,
    labelled: labelProblem === undefined,
    ...(labelProblem ? { labelProblem } : {}),
  };
}

type CommentResult = { changeId: number; id: string | null; labelled: true };

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
  await indexed(env, viewer, docId);
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
    labelled: true,
    revisionId,
  });
  return { changeId, id, labelled: true };
}
