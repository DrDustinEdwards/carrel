// Google Slides and Sheets through the service account, behind the same tools and the same
// rules as Docs: Owner only, only a file in the manuscripts index, every tool refused on a file locked "no AI", every
// comment saying which AI wrote it and why, every change a row in doc_edits. What differs is what
// Google offers, and so what the rules mean here:
//
// - Slides has no suggest mode. An AI reads and comments by default (a comment anchored on quoted text or on a slide),
//   and changes a slide's text only on the Owner's own ask (mode "write"), refused on a file locked "suggest only".
//   Carrel keeps the text it replaced (doc_edits) and emails Dustin by his Docs email setting; only a Doc has undo.
// - Sheets never changes his cells. An AI writes cells only on a tab Carrel made (sheet_tabs), created on the first write
//   under the title asked for; naming one of his tabs is refused. A new tab starts with a comment saying which AI made it.
// - Comments go through Google's own comment requests in the Slides and Sheets batchUpdate not Drive's comments, which the editors do not show when anchored.
// Quotes name text as in Docs: Carrel finds the quote in a fresh read and refuses one that is missing or repeated.

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
  locate,
  type Para,
  planEdits,
  postBatch,
  READ_LIMIT,
  readGoogleDoc,
  writeDone,
  writtenOf,
  type CommentAnchor,
  type CommentInput,
  type DocRead,
  type EditAsked,
  type Thread,
} from "./docs.server";
import { saClient } from "./service-account.server";
import { fetchSheet, threadsOf, readSheet, SHEETS, tabOf, writeInSheet } from "./sheets.server";

type Fetch = typeof fetch;

const SLIDES = "https://slides.googleapis.com/v1/presentations";
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
    beforeText: shapes
      .map((s) => s.text)
      .join("\n---\n")
      .slice(0, BEFORE_LIMIT),
    undoable: false,
  });
}

/** A Doc, a Slides file or a Sheet in the index, read as the tools show it. */
export async function readSheetFile(
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
        };
      }
      if (!only)
        throw new AiRefusal(
          "A new comment needs quote (words on a slide) or tab (the slide's number).",
        );
      return { fields: { objectId: only } };
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
