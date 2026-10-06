// Work that waits on a person and is not in Carrel's index of the site: an AI draft or a draft of
// their own for a post the site does not have yet. Without this the project's list shows only what
// the site reports, and such a draft is reachable only by typing its URL. The list also marks an
// indexed post that has AI drafts waiting beside the person's own.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts, drafts } from "~/db/schema";
import type { Filters, IndexedItem } from "~/lib/index.server";
import type { Viewer } from "~/lib/people.server";
import type { ProjectRole } from "~/lib/content.server";
import { can } from "~/lib/roles";

export type Waiting = {
  itemId: string;
  aiDrafts: number;
  ownDraft: boolean;
  title: string;
  /** The title, id and text, lower-cased, for the list's search. Never sent to the browser. */
  text: string;
  at: string;
};

export type ListedItem = IndexedItem & { aiDrafts: number; isNew: boolean; ownDraft: boolean };

/** The title from a source's frontmatter, or "" when it has none. */
export function titleOf(source: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const line = front?.[1]?.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return line.replace(/^(["'])(.*)\1$/, "$2");
}

/** Every item the person has an AI draft or a draft of their own for, with what is waiting. */
export async function waitingWork(db: D1Database, project: ProjectRole, viewer: Viewer): Promise<Waiting[]> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  const d = drizzle(db);
  const [ai, own] = await Promise.all([
    d
      .select({ itemId: aiDrafts.itemId, source: aiDrafts.source, at: aiDrafts.createdAt })
      .from(aiDrafts)
      .where(and(eq(aiDrafts.projectId, project.id), eq(aiDrafts.personId, viewer.id)))
      .all(),
    d
      .select({ itemId: drafts.itemId, source: drafts.source, at: drafts.updatedAt })
      .from(drafts)
      .where(and(eq(drafts.projectId, project.id), eq(drafts.personId, viewer.id)))
      .all(),
  ]);
  const byItem = new Map<string, Waiting>();
  const entry = (itemId: string) => {
    let w = byItem.get(itemId);
    if (!w) byItem.set(itemId, (w = { itemId, aiDrafts: 0, ownDraft: false, title: "", text: itemId.toLowerCase(), at: "" }));
    return w;
  };
  for (const row of own) {
    const w = entry(row.itemId);
    w.ownDraft = true;
    w.title = titleOf(row.source) || w.title;
    w.text += `\n${row.source.toLowerCase()}`;
    if (row.at > w.at) w.at = row.at;
  }
  for (const row of ai) {
    const w = entry(row.itemId);
    w.aiDrafts += 1;
    w.title ||= titleOf(row.source);
    w.text += `\n${row.source.toLowerCase()}`;
    if (row.at > w.at) w.at = row.at;
  }
  return [...byItem.values()];
}

/**
 * The index's items with the waiting work laid over them: an indexed item gets its count of AI
 * drafts, and an item the index does not have is listed as a new draft. A new item has no kind the
 * site knows, so a kind filter leaves it out; the status filter and the search apply to it as to
 * the rest.
 */
export function withWaitingWork(items: IndexedItem[], waiting: Waiting[], filters: Filters): ListedItem[] {
  const byId = new Map(waiting.map((w) => [w.itemId, w]));
  const listed: ListedItem[] = items.map((item) => ({
    ...item,
    aiDrafts: byId.get(item.itemId)?.aiDrafts ?? 0,
    isNew: false,
    ownDraft: byId.get(item.itemId)?.ownDraft ?? false,
  }));
  if (filters.kind || (filters.status && filters.status !== "draft")) return listed;
  const words = filters.q?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (filters.q && words.length === 0) return listed;
  const indexed = new Set(items.map((i) => i.itemId));
  const fresh: ListedItem[] = waiting
    .filter((w) => !indexed.has(w.itemId) && words.every((word) => w.text.includes(word)))
    .map((w) => ({
      itemId: w.itemId,
      kind: "",
      title: w.title || w.itemId,
      status: "draft" as const,
      path: null,
      publishAt: null,
      publishedAt: null,
      updatedAt: w.at,
      aiDrafts: w.aiDrafts,
      isNew: true,
      ownDraft: w.ownDraft,
    }));
  return [...fresh, ...listed];
}
