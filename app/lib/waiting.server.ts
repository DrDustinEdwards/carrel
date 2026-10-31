// Work that waits on a person and is not in Carrel's index of the site: an AI draft or a draft of
// their own for a post the site does not have yet. Without this the project's list shows only what
// the site reports, and such a draft is reachable only by typing its URL. The list also marks an
// indexed post that has AI drafts waiting beside the person's own.

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts, drafts } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import type { ProjectRole } from "~/lib/content.server";
import { can } from "~/lib/roles";
import { readKey, splitSource } from "@dustinedwards/site-api/frontmatter";

export type Waiting = {
  itemId: string;
  aiDrafts: number;
  ownDraft: boolean;
  title: string;
  /** The title, id and text, lower-cased, for the list's search. Never sent to the browser. */
  text: string;
  at: string;
};

/** The title from a source's frontmatter, or "" when it has none. */
export function titleOf(source: string): string {
  return readKey(splitSource(source).front, "title").trim();
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
 * The waiting work on posts the site does not have yet (not in the index, not on the page): each is a
 * new draft, listed with its title and what waits. The search applies to it as to the site's posts,
 * every word in the title, id or text.
 */
export function onlyInCarrel(waiting: Waiting[], known: ReadonlySet<string>, q?: string): Array<Pick<Waiting, "itemId" | "title" | "aiDrafts" | "ownDraft">> {
  const words = q?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (q && words.length === 0) return [];
  return waiting
    .filter((w) => !known.has(w.itemId) && words.every((word) => w.text.includes(word)))
    .map(({ itemId, title, aiDrafts, ownDraft }) => ({ itemId, title: title || itemId, aiDrafts, ownDraft }));
}
