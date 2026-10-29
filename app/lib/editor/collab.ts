// One file's shared working copy, as a Yjs document (ruling point 3, build step 10; editor spike 7).
// The room's Durable Object holds it, and every editor open on the file holds a copy that Yjs keeps
// the same. The same functions run in both places, so what an editor shows and what a save writes
// are one computation.
//
// The document has two parts:
// - `default`, the editor's blocks as Tiptap's Collaboration extension binds them. Every block keeps
//   its origin (`md`: the bytes it was read from), so the source-preserving save works on the shared
//   copy as it does on one person's: unchanged blocks are written as their bytes.
// - `carrel`, what the save needs besides the blocks: the version the copy was started from (site-api's
//   expectedVersion, or a book file's Git sha), the bytes after the last block, the dialect, the text
//   as last saved or loaded (to tell whether anything is unsaved), and `prints`, each original block's
//   fingerprint by origin id, which says whether a block still holds exactly what it was read from.
//
// A replacement (Discard, the site's newer version, an AI draft taken as the working copy) is made in
// one Yjs transaction by the room's server, so everyone sees it at once and two people cannot make
// it twice. `prosemirrorToYXmlFragment` changes only the blocks that differ, so the comments anchored
// in the others stay where they were.

import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { fingerprints, fromDoc, toDoc, type Dialect, type JsonNode } from "./markdown.mjs";
import { editorSchema } from "./schema.mjs";
import { settle, type JsonDoc } from "./suggest";

export const FRAGMENT = "default";
const META = "carrel";
const PRINTS = "prints";

export type RoomMeta = {
  version: string | null;
  tail: string;
  dialect: Dialect;
  /** The Markdown as last saved, or as it was when the copy was loaded: no unsaved change when equal. */
  saved: string;
};

let schema: ReturnType<typeof editorSchema> | null = null;
/** The editor's schema, built once: the room's server has no editor to ask. */
export function roomSchema() {
  return (schema ??= editorSchema());
}

const metaOf = (ydoc: Y.Doc) => ydoc.getMap<unknown>(META);

export function isSeeded(ydoc: Y.Doc): boolean {
  return metaOf(ydoc).has("dialect");
}

export function readMeta(ydoc: Y.Doc): RoomMeta {
  const m = metaOf(ydoc);
  return {
    version: (m.get("version") as string | null | undefined) ?? null,
    tail: (m.get("tail") as string | undefined) ?? "",
    dialect: ((m.get("dialect") as Dialect | undefined) ?? "site") as Dialect,
    saved: (m.get("saved") as string | undefined) ?? "",
  };
}

function printsOf(ydoc: Y.Doc): Map<number, string> {
  const prints = metaOf(ydoc).get(PRINTS);
  const out = new Map<number, string>();
  if (prints instanceof Y.Map) for (const [id, print] of prints.entries()) out.set(Number(id), String(print));
  return out;
}

/**
 * Puts `markdown` in as the whole document, keeping the blocks that are already the same, and starts
 * the save's bookkeeping from it. The first load of a room and every replacement both come here.
 * `saved` is the text as the site or Git holds it, when that differs (a room started from a draft).
 */
export function loadMarkdown(ydoc: Y.Doc, input: { markdown: string; version: string | null; dialect?: Dialect; saved?: string }): void {
  const dialect = input.dialect ?? readMeta(ydoc).dialect;
  const loaded = toDoc(input.markdown, dialect);
  const node = roomSchema().nodeFromJSON(loaded.doc);
  // The prints are taken from the schema's own nodes, as an editor would see them after loading.
  const prints = fingerprints(node.toJSON() as JsonNode);
  ydoc.transact(() => {
    prosemirrorToYXmlFragment(node, ydoc.getXmlFragment(FRAGMENT));
    const m = metaOf(ydoc);
    const shared = new Y.Map<string>();
    for (const [id, print] of prints) shared.set(String(id), print);
    m.set(PRINTS, shared);
    m.set("tail", loaded.tail);
    m.set("dialect", dialect);
    m.set("version", input.version);
    m.set("saved", input.saved ?? input.markdown);
  });
}

/** Adds the fingerprints of blocks an editor read in from Markdown typed in the Markdown view. */
function addPrints(ydoc: Y.Doc, prints: Map<number, string>, tail?: string): void {
  const shared = metaOf(ydoc).get(PRINTS);
  if (!(shared instanceof Y.Map)) return;
  ydoc.transact(() => {
    for (const [id, print] of prints) shared.set(String(id), print);
    if (tail !== undefined && tail !== readMeta(ydoc).tail) metaOf(ydoc).set("tail", tail);
  });
}

const SUGGESTION_MARKS = new Set(["insertion", "deletion", "modification"]);
function hasSuggestion(node: JsonDoc): boolean {
  return Boolean(node.attrs?.smark) || (node.marks ?? []).some((m) => SUGGESTION_MARKS.has(m.type)) || (node.content ?? []).some(hasSuggestion);
}

export type Patched = { ok: true; changed: boolean } | { ok: false; reason: "suggestions" };

/**
 * Takes Markdown typed in the Markdown view (or a front matter field) into the shared copy, changing
 * only the blocks whose bytes differ, so the others keep their place, their comments and their
 * suggestions. Refused when a block it would change holds a pending suggestion, which Markdown cannot
 * show: those are accepted or rejected first.
 */
export function patchMarkdown(ydoc: Y.Doc, markdown: string): Patched {
  if (markdown === roomMarkdown(ydoc)) return { ok: true, changed: false };
  const meta = readMeta(ydoc);
  const schema = roomSchema();
  const prints = printsOf(ydoc);
  const current = roomJson(ydoc).content ?? [];
  const loaded = toDoc(markdown, meta.dialect);
  const incoming = (loaded.doc.content ?? []) as JsonDoc[];
  /** The bytes a block in the room writes now, and whether those are the incoming block's. */
  const unchanged = (raw: JsonDoc, fresh: JsonDoc) => {
    const settled = hasSuggestion(raw) ? (settle(schema, { type: "doc", content: [raw] }).content ?? []) : [raw];
    if (settled.length !== 1) return false;
    const md = fresh.attrs?.md as { source: string; before: string };
    const written = fromDoc({ type: "doc", content: settled } as JsonNode, "", prints, meta.dialect);
    return written === md.before + md.source || (!settled[0]!.attrs?.md && written === md.source);
  };
  let head = 0;
  while (head < current.length && head < incoming.length && unchanged(current[head]!, incoming[head]!)) head++;
  let tail = 0;
  while (tail < current.length - head && tail < incoming.length - head && unchanged(current[current.length - 1 - tail]!, incoming[incoming.length - 1 - tail]!)) tail++;
  const replaced = current.slice(head, current.length - tail);
  if (replaced.some(hasSuggestion)) return { ok: false, reason: "suggestions" };
  // New blocks take origin ids no block in the room has, so no print is read for the wrong block.
  const ids = [...prints.keys(), ...current.map((b) => (b.attrs?.md as { id?: number } | null)?.id ?? -1)];
  let next = Math.max(-1, ...ids) + 1;
  const fresh = incoming.slice(head, incoming.length - tail).map((b) => ({ ...b, attrs: { ...b.attrs, md: { ...(b.attrs?.md as object), id: next++ } } }));
  const node = schema.nodeFromJSON({ type: "doc", content: [...current.slice(0, head), ...fresh, ...current.slice(current.length - tail)] });
  const added = fingerprints({ type: "doc", content: fresh.map((b) => schema.nodeFromJSON(b).toJSON()) } as JsonNode);
  ydoc.transact(() => {
    prosemirrorToYXmlFragment(node, ydoc.getXmlFragment(FRAGMENT));
    addPrints(ydoc, added, loaded.tail);
  });
  return { ok: true, changed: true };
}

/** After a save: the version it made, and the text it wrote, so nothing reads as unsaved. */
export function markSaved(ydoc: Y.Doc, version: string | null, markdown: string): void {
  ydoc.transact(() => {
    metaOf(ydoc).set("version", version);
    metaOf(ydoc).set("saved", markdown);
  });
}

/** The editor's document as JSON, straight out of the shared copy, suggestions and all. */
export function roomJson(ydoc: Y.Doc): JsonDoc {
  return yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(FRAGMENT)) as JsonDoc;
}

/** The Markdown the shared copy stands for, with every pending suggestion left out: what a save writes. */
export function roomMarkdown(ydoc: Y.Doc): string {
  const meta = readMeta(ydoc);
  const json = settle(roomSchema(), roomJson(ydoc));
  return fromDoc(json as JsonNode, meta.tail, printsOf(ydoc), meta.dialect);
}

/** The Markdown for a document an editor holds as JSON, with the room's bookkeeping. */
export function markdownOf(ydoc: Y.Doc, editorJson: JsonDoc): string {
  const meta = readMeta(ydoc);
  return fromDoc(settle(roomSchema(), editorJson) as JsonNode, meta.tail, printsOf(ydoc), meta.dialect);
}

/** The name of the room for one file: its project and the item's id (a post's id, or a book file's path). */
export function roomName(projectId: number, itemId: string): string {
  return `${projectId}/${itemId}`;
}

export function parseRoomName(name: string): { projectId: number; itemId: string } | null {
  const at = name.indexOf("/");
  const projectId = Number(name.slice(0, at));
  return at > 0 && Number.isInteger(projectId) ? { projectId, itemId: name.slice(at + 1) } : null;
}
