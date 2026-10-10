// The binder (design 4.1, ruling point 7): a book as one tree, and what a reorder in it means in Git.
// Order lives in the NN- prefix of each chapter folder and scene file, so moving a scene or a chapter
// is renaming: every chapter and scene after the drop point is renumbered, and all the renames go in
// one commit. Pure, so the browser, the server and the tests share it.

import { chapterOf, kindOf, readingOrder, titleFromSegment, type Meta } from "~/lib/novels/layout";

/** A row of the binder as the loader sends it; the page turns `meta` into the row's muted note. */
export type BinderNode = { id: string; label: string; href?: string; meta?: string; children?: BinderNode[] };

/** One chapter in a desired order: its folder as it is now, and its scenes' paths as they are now. */
export type ChapterOrder = { chapter: string; scenes: string[] };

export type Rename = { from: string; to: string };

const NUMBERED = /^(\d{2,3})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const ROOT = { chapters: "group:chapters", bible: "group:bible", outline: "group:outline", notes: "group:notes" } as const;
export const chapterId = (slug: string) => `ch:${slug}`;
export const fileId = (path: string) => `f:${path}`;
export const pathOf = (id: string) => (id.startsWith("f:") ? id.slice(2) : null);
export const chapterOfId = (id: string) => (id.startsWith("ch:") ? id.slice(3) : null);

type IndexedLike = { path: string; words: number; meta: Meta };

const entryName = (meta: Meta) => (meta.kind === "character" || meta.kind === "place" || meta.kind === "rule" ? meta.entry.name : "");

const fileName = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
const words = (n: number) => `${n.toLocaleString("en-US")} word${n === 1 ? "" : "s"}`;

/** The book as the binder shows it: title page, chapters and their scenes, bible, outline, notes. */
export function binderTree(files: IndexedLike[], base: string): BinderNode[] {
  const href = (path: string) => `${base}/f/${path}`;
  const nodes: BinderNode[] = [];
  if (files.some((f) => f.path === "book.md")) nodes.push({ id: fileId("book.md"), label: "Title page", href: href("book.md") });

  const chapters: BinderNode[] = [];
  for (const scene of readingOrder(files)) {
    const slug = chapterOf(scene.path)!;
    let chapter = chapters.at(-1);
    if (!chapter || chapter.id !== chapterId(slug)) {
      chapter = { id: chapterId(slug), label: titleFromSegment(slug), href: `${base}/c/${slug}`, children: [] };
      chapters.push(chapter);
    }
    // An index row from before the status key has no status until it is read again.
    const status = scene.meta.kind === "scene" ? (scene.meta.header.status ?? "") : "";
    chapter.children!.push({ id: fileId(scene.path), label: titleFromSegment(fileName(scene.path)), href: href(scene.path), meta: [status, words(scene.words)].filter(Boolean).join(", ") });
  }
  for (const c of chapters) {
    const total = files.filter((f) => chapterOf(f.path) === chapterOfId(c.id)).reduce((n, f) => n + f.words, 0);
    c.meta = words(total);
  }
  nodes.push({ id: ROOT.chapters, label: "Chapters", children: chapters });

  const bible = (folder: string, label: string): BinderNode => ({
    id: `group:bible-${folder}`,
    label,
    children: files
      .filter((f) => f.path.startsWith(`bible/${folder}/`))
      .map((f) => ({ id: fileId(f.path), label: entryName(f.meta) || titleFromSegment(fileName(f.path)), href: href(f.path) })),
  });
  nodes.push({ id: ROOT.bible, label: "Bible", children: [bible("characters", "Characters"), bible("places", "Places"), bible("rules", "World rules")] });
  const flat = (top: "outline" | "notes", id: string, label: string): BinderNode => ({
    id,
    label,
    children: files.filter((f) => f.path.startsWith(`${top}/`)).map((f) => ({ id: fileId(f.path), label: titleFromSegment(fileName(f.path)), href: href(f.path) })),
  });
  nodes.push(flat("outline", ROOT.outline, "Outline"));
  nodes.push(flat("notes", ROOT.notes, "Notes"));
  return nodes;
}

/** Only scenes and chapters move: a scene into any chapter, a chapter among the chapters. */
export function canMoveTo(id: string, parent: string | null): boolean {
  const path = pathOf(id);
  if (path && kindOf(path) === "scene") return parent !== null && parent.startsWith("ch:");
  if (chapterOfId(id)) return parent === ROOT.chapters;
  return false;
}

/** The order a binder tree shows, read back as chapters and their scenes. */
export function orderFromTree(nodes: readonly BinderNode[]): ChapterOrder[] {
  const chapters = nodes.find((n) => n.id === ROOT.chapters)?.children ?? [];
  return chapters.map((c) => ({ chapter: chapterOfId(c.id) ?? "", scenes: (c.children ?? []).map((s) => pathOf(s.id) ?? "") }));
}

/** The order the index holds now. */
export function currentOrder(paths: string[]): ChapterOrder[] {
  const out: ChapterOrder[] = [];
  for (const scene of readingOrder(paths.map((path) => ({ path })))) {
    const chapter = chapterOf(scene.path)!;
    if (out.at(-1)?.chapter !== chapter) out.push({ chapter, scenes: [] });
    out.at(-1)!.scenes.push(scene.path);
  }
  return out;
}

const numbered = (i: number, width: number, name: string) => `${String(i + 1).padStart(width, "0")}-${name}`;
const nameOf = (segment: string) => NUMBERED.exec(segment)?.[2] ?? segment;

/**
 * The renames that turn the book's current order into `desired`. The desired order must hold exactly
 * the chapters and scenes there are now, each once; anything else means the page was out of date.
 * Chapters and scenes are numbered from 01 in their new order, keeping their names; a chapter left
 * with no scenes has no folder in Git, so it drops out and the rest close up.
 */
export function planRenames(paths: string[], desired: ChapterOrder[]): { ok: true; renames: Rename[] } | { ok: false; error: string } {
  const now = currentOrder(paths);
  const chapters = new Set(now.map((c) => c.chapter));
  const scenes = new Set(now.flatMap((c) => c.scenes));
  const stale = { ok: false as const, error: "The book changed since this page was loaded. Reload it and move again." };

  const seenChapters = new Set<string>();
  const seenScenes = new Set<string>();
  for (const c of desired) {
    if (!chapters.has(c.chapter) || seenChapters.has(c.chapter)) return stale;
    seenChapters.add(c.chapter);
    for (const s of c.scenes) {
      if (!scenes.has(s) || seenScenes.has(s)) return stale;
      seenScenes.add(s);
    }
  }
  if (seenChapters.size !== chapters.size || seenScenes.size !== scenes.size) return stale;

  const kept = desired.filter((c) => c.scenes.length > 0);
  const chapterWidth = Math.max(2, String(kept.length).length);
  const renames: Rename[] = [];
  kept.forEach((c, i) => {
    const folder = numbered(i, chapterWidth, nameOf(c.chapter));
    const sceneWidth = Math.max(2, String(c.scenes.length).length);
    c.scenes.forEach((from, j) => {
      const to = `chapters/${folder}/${numbered(j, sceneWidth, nameOf(fileName(from)))}.md`;
      if (to !== from) renames.push({ from, to });
    });
  });
  return { ok: true, renames };
}

/** The desired order with one chapter's scenes put in `order` (the corkboard's move). */
export function withChapterOrder(paths: string[], chapter: string, order: string[]): ChapterOrder[] {
  return currentOrder(paths).map((c) => (c.chapter === chapter ? { chapter, scenes: order } : c));
}

/** The first sentence of a scene's text, for a card with no summary: at most 160 characters. */
export function firstSentence(body: string): string {
  const text = body.replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.length > 160 ? `${sentence.slice(0, 159).trimEnd()}...` : sentence;
}

/** The order a form posted as JSON, or null when it is not a list of chapters with scene paths. */
export function parseOrder(raw: string): ChapterOrder[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > 500) return null;
  const out: ChapterOrder[] = [];
  for (const c of value) {
    if (!c || typeof c !== "object") return null;
    const { chapter, scenes } = c as Record<string, unknown>;
    if (typeof chapter !== "string" || !Array.isArray(scenes) || !scenes.every((s) => typeof s === "string")) return null;
    out.push({ chapter, scenes: scenes as string[] });
  }
  return out;
}

/**
 * A site project's binder: its writing grouped by kind (posts, pages and the rest), newest first, each
 * with its state. Series join it when the site-api contract carries them (ruling point 5, build step
 * 7); until then there is nothing to order, so a site's binder only finds and opens.
 */
export function siteBinderTree(items: { itemId: string; kind: string; title: string; status: string }[], base: string): BinderNode[] {
  const kinds = [...new Set(items.map((i) => i.kind))].sort((a, b) => (a === "post" ? -1 : b === "post" ? 1 : a < b ? -1 : 1));
  const plural = (kind: string) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${kind.endsWith("s") ? "" : "s"}`;
  return kinds.map((kind) => ({
    id: `kind:${kind}`,
    label: plural(kind),
    children: items
      .filter((i) => i.kind === kind)
      .map((i) => ({ id: `item:${i.itemId}`, label: i.title || i.itemId, href: `${base}/e/${encodeURIComponent(i.itemId)}`, meta: i.status.charAt(0).toUpperCase() + i.status.slice(1) })),
  }));
}
