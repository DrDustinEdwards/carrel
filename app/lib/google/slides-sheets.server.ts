// Google Slides and Sheets through the service account (the Docs plan, slice 9), behind the same tools and the same
// rules as Docs: Owner only, only a file in the manuscripts index, every tool refused on a file locked "no AI", every
// comment saying which AI wrote it and why, every change a row in doc_changes or doc_actions. What differs is what
// Google offers, and so what the rules mean here:
//
// - Slides has no suggest mode. An AI reads and comments by default (a comment anchored on quoted text or on a slide),
//   and changes a slide's text only on the Owner's own ask (mode "write"), refused on a file locked "suggest only".
//   Carrel keeps the text it replaced (doc_actions) and emails Dustin by his Docs email setting; only a Doc has undo.
// - Sheets never changes his cells. An AI writes cells only on a tab Carrel made (sheet_tabs), created on the first write
//   under the title asked for; naming one of his tabs is refused. A new tab starts with a comment saying which AI made it.
// - Comments go through Google's own comment requests in the Slides and Sheets batchUpdate (general availability
//   2026-09-30), not Drive's comments, which the editors do not show when anchored.
// Quotes name text as in Docs: Carrel finds the quote in a fresh read and refuses one that is missing or repeated.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sheetTabs } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import type { Viewer } from "~/lib/people.server";

import {
  AI_FILES,
  BEFORE_LIMIT,
  changeInDoc,
  commentInDoc,
  commentInFile,
  GOOGLE_DOC,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  googleError,
  indexedFile,
  labelOf,
  locate,
  type Para,
  planEdits,
  postBatch,
  postsOf,
  READ_LIMIT,
  readGoogleDoc,
  record,
  writeDone,
  writtenOf,
  type CommentAnchor,
  type CommentInput,
  type DocRead,
  type EditAsked,
  type Thread,
} from "./docs.server";
import { saClient } from "./service-account.server";

type Fetch = typeof fetch;

const SLIDES = "https://slides.googleapis.com/v1/presentations";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
/** Rows and columns read from a tab: fewer when every tab is read at once. */
const ROWS = { all: 200, one: 2000 } as const;
const COLUMNS = 26;
/** The most one Sheets write carries: tabs, rows, columns and cells. */
const SHEET_MAX = {
  tabs: 20,
  rows: 1000,
  columns: 100,
  cells: 10_000,
  cell: 5000,
  title: 100,
} as const;

/** The kind a tool call names in its answer. */
export function fileKind(mimeType: string): "doc" | "slides" | "sheet" {
  return mimeType === GOOGLE_SLIDES ? "slides" : mimeType === GOOGLE_SHEET ? "sheet" : "doc";
}

type TextElement = { textRun?: { content?: string } };
type PageElement = {
  objectId: string;
  shape?: { text?: { textElements?: TextElement[] } };
  elementGroup?: { children?: PageElement[] };
};
type Page = {
  objectId: string;
  pageElements?: PageElement[];
  slideProperties?: { notesPage?: Page };
  notesProperties?: { speakerNotesObjectId?: string };
  commentAnchors?: {
    anchorId?: string;
    objectAnchors?: {
      objectId?: string;
      shapeTextAnchors?: { ranges?: { startIndex?: number; endIndex?: number }[] };
    }[];
  }[];
};
type Presentation = {
  presentationId: string;
  title?: string;
  revisionId?: string;
  slides?: Page[];
  comments?: Thread[];
};
/** One shape's text on a slide (or the slide's speaker notes), with the positions Google counts in it. */
type Shape = { slide: number; slideId: string; objectId: string; notes: boolean; text: string };

async function fetchSlides(env: Env, id: string, fetcher?: Fetch): Promise<Presentation> {
  const params = new URLSearchParams({ commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED" });
  const res = await saClient(env, fetcher).request("GET", `${SLIDES}/${id}?${params}`);
  if (!res.ok) return googleError(res, "read the presentation");
  return (await res.json()) as Presentation;
}

function shapesOf(p: Presentation): Shape[] {
  const out: Shape[] = [];
  const walk = (els: PageElement[] | undefined, at: Omit<Shape, "objectId" | "text">) => {
    for (const el of els ?? []) {
      if (el.elementGroup) walk(el.elementGroup.children, at);
      const text = (el.shape?.text?.textElements ?? [])
        .map((t) => t.textRun?.content ?? "")
        .join("");
      if (text.trim()) out.push({ ...at, objectId: el.objectId, text });
    }
  };
  (p.slides ?? []).forEach((slide, i) => {
    const at = { slide: i + 1, slideId: slide.objectId, notes: false };
    walk(slide.pageElements, at);
    const notes = slide.slideProperties?.notesPage;
    const speaker = notes?.notesProperties?.speakerNotesObjectId;
    walk(
      (notes?.pageElements ?? []).filter((e) => e.objectId === speaker),
      { ...at, notes: true },
    );
  });
  return out;
}

/** The slide a `tab` names: its number ("3") or its object id; undefined when none is named. */
function slideIdOf(p: Presentation, tab: string | undefined): string | undefined {
  if (!tab) return undefined;
  const slides = p.slides ?? [];
  const byNumber = /^\d{1,4}$/.test(tab) ? slides[Number(tab) - 1] : undefined;
  const found = byNumber ?? slides.find((s) => s.objectId === tab);
  if (!found)
    throw new AiRefusal(
      `This presentation has no slide ${tab}. It has ${slides.length} slides, numbered from 1.`,
    );
  return found.objectId;
}

/** A file's comment threads as a read shows them, each with the words or the place it is on. */
function threadsOf(threads: Thread[] | undefined, where: Map<string, string>): DocRead["comments"] {
  return (threads ?? []).map((t) => ({
    id: t.commentId ?? "",
    status: t.status ?? "OPEN",
    quote: where.get(t.anchorId ?? "") ?? "",
    posts: postsOf(t),
  }));
}

/**
 * The text boxes as Docs-style paragraphs, one per line, so a quote is found and an edit planned by the same code as
 * in a Doc: `tabId` is the box's object id and `tabTitle` the id of its slide (what a slide's tab filter matches).
 */
function parasOf(shapes: Shape[], only?: string): Para[] {
  return shapes
    .filter((x) => !only || x.slideId === only)
    .flatMap((x) => {
      let start = 0;
      return x.text.split(/(?<=\n)/).map((line) => {
        const seg = { start, end: start + line.length, text: line, state: "plain" as const };
        start = seg.end;
        return { tabId: x.objectId, tabTitle: x.slideId, heading: 0, segs: [seg] };
      });
    });
}

function readSlides(
  p: Presentation,
  row: { name: string; webViewLink: string },
  tab?: string,
): DocRead {
  const only = slideIdOf(p, tab);
  const shapes = shapesOf(p);
  const slides = (p.slides ?? []).filter((s) => !only || s.objectId === only);
  const own = (slide: Page) => shapes.filter((s) => s.slideId === slide.objectId);
  const full = slides
    .map((slide) => {
      const n = (p.slides ?? []).indexOf(slide) + 1;
      const boxes = own(slide).map((s) => `${s.notes ? "Notes: " : ""}${s.text.trimEnd()}`);
      return `## Slide ${n} (${slide.objectId})\n${boxes.join("\n\n")}`;
    })
    .join("\n\n");
  const where = new Map<string, string>();
  for (const slide of p.slides ?? [])
    for (const a of slide.commentAnchors ?? []) {
      const n = (p.slides ?? []).indexOf(slide) + 1;
      const at = a.objectAnchors?.[0];
      const range = at?.shapeTextAnchors?.ranges?.[0];
      const shape = shapes.find((s) => s.objectId === at?.objectId);
      where.set(
        a.anchorId ?? "",
        shape && range?.startIndex !== undefined && range.endIndex !== undefined
          ? shape.text.slice(range.startIndex, range.endIndex)
          : `Slide ${n}`,
      );
    }
  return {
    docId: p.presentationId,
    title: row.name || p.title || "",
    url: row.webViewLink,
    revisionId: p.revisionId ?? null,
    tabs: (p.slides ?? []).map((slide, i) => ({
      tabId: slide.objectId,
      title: `Slide ${i + 1}: ${(own(slide)[0]?.text.split("\n")[0] ?? "").slice(0, 60)}`,
      paragraphs: own(slide).length,
      chars: own(slide).reduce((n, s) => n + s.text.length, 0),
    })),
    text: full.slice(0, READ_LIMIT),
    truncated: full.length > READ_LIMIT,
    suggestions: [],
    comments: threadsOf(p.comments, where),
  };
}

/** Changes a slide's text directly, on the Owner's own ask: Slides has no suggestions. */
async function writeInSlides(
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
) {
  if (input.mode !== "write")
    throw new AiRefusal(
      'Slides has no suggestions. Comment instead (carrel_comment_doc), or, only when Dustin asked you in this conversation to change the slides directly, give mode "write".',
    );
  const row = await indexedFile(env, viewer, docId, "write", [GOOGLE_SLIDES]);
  const p = await fetchSlides(env, docId, fetcher);
  const shapes = shapesOf(p);
  const planned = planEdits(parasOf(shapes, slideIdOf(p, input.tab)), input.edits, undefined);
  // Last position first, so an earlier edit's text does not move a later one's positions.
  const requests: Record<string, unknown>[] = [];
  for (const e of [...planned].sort((x, y) => y.at.start - x.at.start)) {
    const objectId = e.at.tabId;
    if (e.remove)
      requests.push({
        deleteText: {
          objectId,
          textRange: { type: "FIXED_RANGE", startIndex: e.at.start, endIndex: e.at.end },
        },
      });
    if (e.insert)
      requests.push({
        insertText: { objectId, text: e.insert, insertionIndex: e.remove ? e.at.start : e.at.end },
      });
  }
  await postBatch(
    env,
    `${SLIDES}/${docId}:batchUpdate`,
    { requests, writeControl: { requiredRevisionId: p.revisionId } },
    fetcher,
    { direct: true },
  );
  const edits = planned.map(writtenOf);
  return writeDone(env, viewer, session, row, {
    model: input.model,
    reason: input.reason,
    edits,
    revisionId: p.revisionId,
    beforeText: shapes
      .map((s) => s.text)
      .join("\n---\n")
      .slice(0, BEFORE_LIMIT),
    undoable: false,
  });
}

type SheetProps = {
  sheetId: number;
  title: string;
  gridProperties?: { rowCount?: number; columnCount?: number };
};
type Spreadsheet = {
  spreadsheetId: string;
  properties?: { title?: string };
  sheets?: {
    properties: SheetProps;
    commentAnchors?: {
      anchorId?: string;
      range?: { sheetId?: number; startRowIndex?: number; startColumnIndex?: number };
    }[];
  }[];
  comments?: Thread[];
};

async function fetchSheet(env: Env, id: string, fetcher?: Fetch): Promise<Spreadsheet> {
  const params = new URLSearchParams({
    commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
    fields:
      "spreadsheetId,properties.title,comments,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),commentAnchors)",
  });
  const res = await saClient(env, fetcher).request("GET", `${SHEETS}/${id}?${params}`);
  if (!res.ok) return googleError(res, "read the spreadsheet");
  return (await res.json()) as Spreadsheet;
}

/** A column's letters, counted from 0 ("A", "B", ... "AA"). */
function columnName(n: number): string {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
const quoteTab = (title: string) => `'${title.replace(/'/g, "''")}'`;

async function madeByCarrel(env: Env, fileId: string): Promise<Set<number>> {
  const rows = await drizzle(env.DB)
    .select({ id: sheetTabs.sheetId })
    .from(sheetTabs)
    .where(eq(sheetTabs.fileId, fileId))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** The tab a `tab` names: its title (any case) or its sheet id. */
function tabOf(s: Spreadsheet, tab: string): SheetProps {
  const wanted = tab.trim().toLowerCase();
  const all = (s.sheets ?? []).map((x) => x.properties);
  const found = all.find(
    (t) => t.title.toLowerCase() === wanted || String(t.sheetId) === tab.trim(),
  );
  if (!found)
    throw new AiRefusal(
      `This spreadsheet has no tab ${tab}. Its tabs: ${all.map((t) => `${t.title} (${t.sheetId})`).join(", ")}.`,
    );
  return found;
}

async function readSheet(
  env: Env,
  s: Spreadsheet,
  row: { fileId: string; name: string; webViewLink: string },
  tab: string | undefined,
  fetcher?: Fetch,
): Promise<DocRead> {
  const all = (s.sheets ?? []).map((x) => x.properties);
  const chosen = tab ? [tabOf(s, tab)] : all;
  const cap = tab ? ROWS.one : ROWS.all;
  const mine = await madeByCarrel(env, row.fileId);
  const ranges = chosen.map((t) => {
    const rows = Math.min(t.gridProperties?.rowCount ?? cap, cap);
    const cols = Math.min(t.gridProperties?.columnCount ?? COLUMNS, COLUMNS);
    return `${quoteTab(t.title)}!A1:${columnName(Math.max(1, cols) - 1)}${Math.max(1, rows)}`;
  });
  const params = new URLSearchParams({ majorDimension: "ROWS" });
  for (const r of ranges) params.append("ranges", r);
  const res = await saClient(env, fetcher).request(
    "GET",
    `${SHEETS}/${row.fileId}/values:batchGet?${params}`,
  );
  if (!res.ok) return googleError(res, "read the cells");
  const got = (await res.json()) as { valueRanges?: { values?: unknown[][] }[] };
  const tabs = chosen.map((t, i) => {
    const values = got.valueRanges?.[i]?.values ?? [];
    const lines = values.flatMap((cells, r) =>
      cells.some((c) => String(c ?? "") !== "")
        ? [`${r + 1}\t${cells.map((c) => String(c ?? "")).join("\t")}`]
        : [],
    );
    const head = `## ${t.title} (${t.sheetId})${mine.has(t.sheetId) ? ", made by Carrel: it may be written" : ""}`;
    return { t, text: [head, ...lines].join("\n"), rows: values.length };
  });
  const full = tabs.map((x) => x.text).join("\n\n");
  const where = new Map<string, string>();
  for (const sheet of s.sheets ?? [])
    for (const a of sheet.commentAnchors ?? [])
      where.set(
        a.anchorId ?? "",
        `${sheet.properties.title}!${columnName(a.range?.startColumnIndex ?? 0)}${(a.range?.startRowIndex ?? 0) + 1}`,
      );
  return {
    docId: s.spreadsheetId,
    title: row.name || s.properties?.title || "",
    url: row.webViewLink,
    revisionId: null,
    tabs: tabs.map((x) => ({
      tabId: String(x.t.sheetId),
      title: x.t.title,
      paragraphs: x.rows,
      chars: x.text.length,
    })),
    text: full.slice(0, READ_LIMIT),
    truncated:
      full.length > READ_LIMIT ||
      chosen.some(
        (t) =>
          (t.gridProperties?.rowCount ?? 0) > cap || (t.gridProperties?.columnCount ?? 0) > COLUMNS,
      ),
    suggestions: [],
    comments: threadsOf(s.comments, where),
  };
}

type SheetEdit = { tab?: unknown; range?: unknown; values?: unknown; reason?: unknown };
type TabWrite = { title: string; range: string; values: (string | number | boolean)[][] };

function tabWrites(edits: unknown): TabWrite[] {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > SHEET_MAX.tabs)
    throw new AiRefusal(
      `edits is a list of 1 to ${SHEET_MAX.tabs} writes, each {tab, range?, values}.`,
    );
  let cells = 0;
  return (edits as SheetEdit[]).map((e, i) => {
    const n = `Edit ${i + 1}`;
    const title = typeof e.tab === "string" ? e.tab.trim() : "";
    if (!title || title.length > SHEET_MAX.title)
      throw new AiRefusal(`${n}: tab is the new tab's title (1 to ${SHEET_MAX.title} characters).`);
    const range = e.range === undefined ? "A1" : e.range;
    if (typeof range !== "string" || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(range))
      throw new AiRefusal(
        `${n}: range is the top-left cell, such as A1 (the rest follows from values).`,
      );
    const rows = e.values;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > SHEET_MAX.rows)
      throw new AiRefusal(`${n}: values is 1 to ${SHEET_MAX.rows} rows, each a list of cells.`);
    const values = rows.map((r) => {
      if (!Array.isArray(r) || r.length === 0 || r.length > SHEET_MAX.columns)
        throw new AiRefusal(`${n}: each row is 1 to ${SHEET_MAX.columns} cells.`);
      return r.map((c) => {
        const v = c ?? "";
        if (
          typeof v === "string"
            ? v.length > SHEET_MAX.cell
            : typeof v !== "number" && typeof v !== "boolean"
        )
          throw new AiRefusal(
            `${n}: a cell is text (up to ${SHEET_MAX.cell} characters), a number or true or false.`,
          );
        cells++;
        return v as string | number | boolean;
      });
    });
    if (cells > SHEET_MAX.cells)
      throw new AiRefusal(`A write carries at most ${SHEET_MAX.cells} cells.`);
    return { title, range, values };
  });
}

/** Writes cells on tabs Carrel made, making each tab on its first write; never on one of Dustin's tabs. */
async function writeInSheet(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  docId: string,
  input: { edits: unknown; reason: string; model?: string; mode?: "suggest" | "write" },
  fetcher?: Fetch,
) {
  if (input.mode === "write")
    throw new AiRefusal(
      "A Sheet is never written over. Leave mode out: the cells go on a new tab Carrel makes (give each edit's tab a new title).",
    );
  const row = await indexedFile(env, viewer, docId, "suggest", [GOOGLE_SHEET]);
  const writes = tabWrites(input.edits);
  const sheet = await fetchSheet(env, docId, fetcher);
  const mine = await madeByCarrel(env, docId);
  const have = new Map(
    (sheet.sheets ?? []).map((s) => [s.properties.title.toLowerCase(), s.properties]),
  );
  const made: SheetProps[] = [];
  for (const w of writes) {
    const key = w.title.toLowerCase();
    const found = have.get(key);
    if (found && !mine.has(found.sheetId))
      throw new AiRefusal(
        `The tab "${found.title}" is Dustin's: Carrel writes cells only on tabs it made. Name a new tab.`,
      );
    if (!found && !made.some((m) => m.title.toLowerCase() === key))
      made.push({
        sheetId: 1_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000),
        title: w.title,
      });
  }
  const d = drizzle(env.DB);
  for (const t of made) {
    await postBatch(
      env,
      `${SHEETS}/${docId}:batchUpdate`,
      { requests: [{ addSheet: { properties: { sheetId: t.sheetId, title: t.title } } }] },
      fetcher,
      { tab: t.title },
    );
    await d
      .insert(sheetTabs)
      .values({ fileId: docId, sheetId: t.sheetId, title: t.title, client: session.client });
  }
  const sa = saClient(env, fetcher);
  for (const w of writes) {
    const title = (
      made.find((m) => m.title.toLowerCase() === w.title.toLowerCase()) ??
      have.get(w.title.toLowerCase())!
    ).title;
    const range = `${quoteTab(title)}!${w.range}`;
    const res = await sa.request(
      "PUT",
      `${SHEETS}/${docId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { range, majorDimension: "ROWS", values: w.values },
      { tab: title },
    );
    if (!res.ok) return googleError(res, "write the cells");
  }
  let labelProblem: string | undefined;
  if (made.length > 0)
    try {
      const done = await postBatch(
        env,
        `${SHEETS}/${docId}:batchUpdate`,
        {
          requests: made.map((t) => ({
            insertComment: {
              content: labelOf(session, input.model, `${input.reason} (this tab)`),
              coordinate: { sheetId: t.sheetId, rowIndex: 0, columnIndex: 0 },
            },
          })),
        },
        fetcher,
      );
      if (done.commentUpdateState === "ALL_FAILED_UNKNOWN_REASON")
        labelProblem = "Google did not save the comment that says which AI made the tab.";
    } catch (error) {
      labelProblem =
        error instanceof AiRefusal
          ? error.message
          : "The comment on the new tab could not be added.";
    }
  const changeId = await record(env, viewer, session, {
    fileId: row.fileId,
    mode: "suggest",
    model: input.model,
    reason: input.reason,
    change: writes.map((w) => ({
      tab: w.title,
      range: w.range,
      rows: w.values.length,
      new: made.some((m) => m.title.toLowerCase() === w.title.toLowerCase()),
    })),
    googleIds: made.map((t) => String(t.sheetId)),
    labeled: labelProblem === undefined,
  });
  return {
    mode: "suggest" as const,
    changeId,
    undo: "",
    edits: writes.length,
    tabs: [...new Set(writes.map((w) => w.title))],
    labeled: labelProblem === undefined,
    ...(labelProblem ? { labelProblem } : {}),
  };
}

/** A Doc, a Slides file or a Sheet in the index, read as the tools show it. */
export async function readFile(
  env: Env,
  viewer: Viewer,
  fileId: string,
  opts: { tab?: string; heading?: string },
  fetcher?: Fetch,
): Promise<DocRead> {
  const row = await indexedFile(env, viewer, fileId, "read", AI_FILES);
  if (row.mimeType === GOOGLE_SLIDES)
    return readSlides(await fetchSlides(env, fileId, fetcher), row, opts.tab);
  if (row.mimeType === GOOGLE_SHEET)
    return readSheet(env, await fetchSheet(env, fileId, fetcher), row, opts.tab, fetcher);
  return readGoogleDoc(env, viewer, fileId, opts, fetcher);
}

/** A comment on a Doc, a Slides file (on quoted text or a slide) or a Sheet (on a cell). */
export async function commentOnFile(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  fileId: string,
  input: CommentInput & { cell?: string },
  fetcher?: Fetch,
) {
  const row = await indexedFile(env, viewer, fileId, "suggest", AI_FILES);
  if (row.mimeType === GOOGLE_DOC)
    return commentInDoc(env, viewer, session, fileId, input, fetcher);
  const slides = row.mimeType === GOOGLE_SLIDES;
  const anchor = async (): Promise<CommentAnchor> => {
    if (slides) {
      const p = await fetchSlides(env, fileId, fetcher);
      const only = slideIdOf(p, input.tab);
      if (input.quote) {
        const at = locate(parasOf(shapesOf(p), only), input.quote, undefined, "quote");
        return {
          fields: {
            shapeTextAnchor: {
              objectId: at.tabId,
              textRange: { type: "FIXED_RANGE", startIndex: at.start, endIndex: at.end },
            },
          },
          revisionId: p.revisionId,
        };
      }
      if (!only)
        throw new AiRefusal(
          "A new comment needs quote (words on a slide) or tab (the slide's number).",
        );
      return { fields: { objectId: only }, revisionId: p.revisionId };
    }
    const cell = /^(?:(.+)!)?([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(input.cell?.trim() ?? "");
    if (!cell)
      throw new AiRefusal(
        "A new comment on a Sheet needs cell, such as B2 or Sheet1!B2 (with tab when the tab is not in it).",
      );
    const s = await fetchSheet(env, fileId, fetcher);
    const tab = tabOf(s, cell[1] ?? input.tab ?? "");
    const column = cell[2]!.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    return {
      fields: {
        coordinate: { sheetId: tab.sheetId, rowIndex: Number(cell[3]) - 1, columnIndex: column },
      },
    };
  };
  return commentInFile(
    env,
    viewer,
    session,
    fileId,
    [row.mimeType],
    `${slides ? SLIDES : SHEETS}/${fileId}:batchUpdate`,
    input,
    anchor,
    fetcher,
  );
}

/** A change to a Doc (suggestions, or a direct write), to a Slides file (a direct write only) or to a Sheet (a new tab). */
export async function changeInFile(
  env: Env,
  viewer: Viewer,
  session: AiSession,
  fileId: string,
  input: Parameters<typeof changeInDoc>[4] & { edits: unknown },
  fetcher?: Fetch,
) {
  const row = await indexedFile(env, viewer, fileId, "read", AI_FILES);
  if (row.mimeType === GOOGLE_SLIDES)
    return writeInSlides(
      env,
      viewer,
      session,
      fileId,
      { ...input, edits: input.edits as EditAsked[] },
      fetcher,
    );
  if (row.mimeType === GOOGLE_SHEET)
    return writeInSheet(env, viewer, session, fileId, input, fetcher);
  return changeInDoc(
    env,
    viewer,
    session,
    fileId,
    { ...input, edits: input.edits as EditAsked[] },
    fetcher,
  );
}
