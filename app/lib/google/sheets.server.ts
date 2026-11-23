// Sheets: cells read from any tab, written only on tabs Carrel made (sheet_tabs).

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sheetTabs } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import type { Viewer } from "~/lib/people.server";

import {
  type DocRead,
  type Thread,
  googleError,
  indexedFile,
  GOOGLE_SHEET,
  labelOf,
  postBatch,
  postsOf,
  READ_LIMIT,
  record,
} from "./docs.server";
import { saClient } from "./service-account.server";

type Fetch = typeof fetch;

/** A file's comment threads as a read shows them, each with the words or the place it is on. */
export function threadsOf(
  threads: Thread[] | undefined,
  where: Map<string, string>,
): DocRead["comments"] {
  return (threads ?? []).map((t) => ({
    id: t.commentId ?? "",
    status: t.status ?? "OPEN",
    quote: where.get(t.anchorId ?? "") ?? "",
    posts: postsOf(t),
  }));
}

export const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
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

export async function fetchSheet(env: Env, id: string, fetcher?: Fetch): Promise<Spreadsheet> {
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
export function tabOf(s: Spreadsheet, tab: string): SheetProps {
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

export async function readSheet(
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
    const shape = `${n}: values is 1 to ${SHEET_MAX.rows} rows of 1 to ${SHEET_MAX.columns} cells.`;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > SHEET_MAX.rows)
      throw new AiRefusal(shape);
    const values = rows.map((r) => {
      if (!Array.isArray(r) || r.length === 0 || r.length > SHEET_MAX.columns)
        throw new AiRefusal(shape);
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
export async function writeInSheet(
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
  const madeSoFar: SheetProps[] = [];
  const written: typeof writes = [];
  const recordDone = (labeled: boolean) =>
    record(env, viewer, session, {
      fileId: row.fileId,
      mode: "suggest",
      model: input.model,
      reason: input.reason,
      change: written.map((w) => ({
        tab: w.title,
        range: w.range,
        rows: w.values.length,
        new: madeSoFar.some((m) => m.title.toLowerCase() === w.title.toLowerCase()),
      })),
      googleIds: madeSoFar.map((t) => String(t.sheetId)),
      labeled,
    });
  // A refusal part-way leaves what Google already took, so what was done is recorded before it is raised.
  try {
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
      madeSoFar.push(t);
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
      written.push(w);
    }
  } catch (error) {
    if (madeSoFar.length > 0 || written.length > 0) await recordDone(false);
    throw error;
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
  const changeId = await recordDone(labelProblem === undefined);
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
