// Bulk actions on a site's posts: add or remove a tag, duplicate, delete. Each post is its own
// write, in order, through the same functions a single save uses, so every role rule, every version
// check and every authorship record is the one the editor has. One post failing (stale, refused, not
// there) never stops the rest, and every post gets an outcome in plain words.

import { ContentId } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";

import { deleteFromSite, readDoc, readDraft, writeToSite } from "~/lib/content.server";
import { joinSource, readFields, setField, setRawKey, setTags, splitSource, tagsOf } from "~/lib/frontmatter";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient, SiteNotConnected } from "~/lib/sites.server";

export const MAX_BULK = 100;

export type BulkRequest = { op: "tag-add"; tag: string } | { op: "tag-remove"; tag: string } | { op: "duplicate" } | { op: "delete" };

/** One post's outcome. `ok` false means this post was left as it was; the message says why. */
export type ItemResult = { id: string; title: string; ok: boolean; message: string; copyId?: string };

/** A tag as a post's frontmatter list can hold it: one short piece of text with nothing that would break the list. */
export function cleanTag(raw: string): string | null {
  const tag = raw.trim();
  if (tag.length === 0 || tag.length > 40) return null;
  if (/[,\[\]"'#:\r\n\\]/.test(tag)) return null;
  return tag;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The ids to act on: unique, each one an id a site could hold. An id that could not be one is reported, not sent. */
export function parseIds(raw: readonly string[]): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const id of new Set(raw)) (ContentId.safeParse(id).success ? ids : invalid).push(id);
  return { ids, invalid };
}

function requireCan(project: { role: SiteProject["role"] }, action: Parameters<typeof can>[1]) {
  if (!can(project.role, action)) throw new Response("Forbidden", { status: 403 });
}

/**
 * Applies one action to each post. The role is checked once before any post is read (a Reader or an
 * Editor who asks to delete is refused outright, and the site is not asked); a post whose own state
 * needs a higher role, such as a live post for an Editor, is refused alone and the rest go on.
 */
export async function bulkApply(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  request: BulkRequest,
  rawIds: readonly string[],
  fetcher?: typeof fetch,
): Promise<ItemResult[]> {
  requireCan(project, request.op === "delete" ? "delete_content" : "edit");
  if (rawIds.length === 0) throw new Response("Choose at least one post.", { status: 400 });
  if (rawIds.length > MAX_BULK) throw new Response(`At most ${MAX_BULK} posts at a time.`, { status: 400 });
  const tag = request.op === "tag-add" || request.op === "tag-remove" ? cleanTag(request.tag) : null;
  if ((request.op === "tag-add" || request.op === "tag-remove") && tag === null) {
    throw new Response("A tag is one short piece of text, with no commas, brackets, quotes or colons.", { status: 400 });
  }

  const { ids, invalid } = parseIds(rawIds);
  const results: ItemResult[] = invalid.map((id) => ({ id, title: id, ok: false, message: "That is not a post id, so it was not sent to the site." }));
  for (const id of ids) {
    try {
      switch (request.op) {
        case "tag-add":
        case "tag-remove":
          results.push(await tagOne(env, project, viewer, id, request.op, tag!, fetcher));
          break;
        case "duplicate":
          results.push(await duplicateOne(env, project, viewer, id, fetcher));
          break;
        case "delete":
          results.push(await deleteOne(env, project, viewer, id, fetcher));
          break;
      }
    } catch (error) {
      results.push(failure(id, error));
    }
  }
  return results;
}

/** What went wrong for one post, said plainly. Anything unexpected is logged and reported, never dropped. */
function failure(id: string, error: unknown): ItemResult {
  if (error instanceof Response && error.status === 403) {
    return { id, title: id, ok: false, message: "Changing a live post is the Owner's step, so this one was left as it was." };
  }
  if (error instanceof SiteNotConnected) return { id, title: id, ok: false, message: error.detail };
  console.error(JSON.stringify({ bulk: "item-failed", id, error: error instanceof Response ? `response ${error.status}` : String(error) }));
  if (error instanceof SiteApiError) return { id, title: id, ok: false, message: "The site did not answer for this post. It was left as it was." };
  return { id, title: id, ok: false, message: "Something went wrong with this post. It was left as it was." };
}

async function tagOne(env: Env, project: SiteProject, viewer: Viewer, id: string, op: "tag-add" | "tag-remove", tag: string, fetcher?: typeof fetch): Promise<ItemResult> {
  const doc = await readDoc(env, project, id, fetcher);
  if (!doc) return { id, title: id, ok: false, message: "The site does not have this post." };
  const title = doc.title || id;
  // Saving to the site clears the person's working copy, which would lose unsaved edits.
  if (await readDraft(env.DB, project, viewer, id)) {
    return { id, title, ok: false, message: "You have a working draft of this post in Carrel. Open it and change the tags there, so the draft is not lost." };
  }
  const parts = splitSource(doc.source);
  if (parts.front === null) return { id, title, ok: false, message: "This post has no frontmatter, so it has no tags to change." };
  const tags = tagsOf(parts.front);
  const has = tags.some((t) => same(t, tag));
  if (op === "tag-add" && has) return { id, title, ok: true, message: `Already tagged "${tag}". Not changed.` };
  if (op === "tag-remove" && !has) return { id, title, ok: true, message: `Did not have the tag "${tag}". Not changed.` };
  const next = op === "tag-add" ? [...tags, tag] : tags.filter((t) => !same(t, tag));
  const source = joinSource({ ...parts, front: setTags(parts.front, next) });
  const outcome = await writeToSite(env, project, viewer, id, { action: "save", source, expectedVersion: doc.version }, fetcher);
  if (!outcome.ok) return { id, title, ok: false, message: outcome.reason === "conflict" ? "The post changed on the site while this ran. Nothing was changed." : outcome.message };
  return { id, title, ok: true, message: op === "tag-add" ? `Added the tag "${tag}".` : `Removed the tag "${tag}".` };
}

const COPY_TRIES = 50;

/** The first of id-copy, id-copy-2, ... that no post, working draft, AI draft or indexed row already uses. */
async function freeCopyId(env: Env, project: SiteProject, id: string, fetcher?: typeof fetch): Promise<{ id: string; n: number } | null> {
  const client = siteClient(env, project.site, fetcher);
  for (let n = 1; n <= COPY_TRIES; n++) {
    const candidate = n === 1 ? `${id}-copy` : `${id}-copy-${n}`;
    if (!ContentId.safeParse(candidate).success) return null;
    const local = await env.DB.prepare(
      `SELECT 1 AS used FROM drafts WHERE project_id = ?1 AND item_id = ?2
       UNION ALL SELECT 1 FROM ai_drafts WHERE project_id = ?1 AND item_id = ?2
       UNION ALL SELECT 1 FROM site_items WHERE project_id = ?1 AND item_id = ?2 LIMIT 1`,
    )
      .bind(project.id, candidate)
      .first();
    if (local) continue;
    try {
      await client.get(candidate);
    } catch (error) {
      if (error instanceof SiteApiError && error.status === 404) return { id: candidate, n };
      throw error;
    }
  }
  return null;
}

async function duplicateOne(env: Env, project: SiteProject, viewer: Viewer, id: string, fetcher?: typeof fetch): Promise<ItemResult> {
  const doc = await readDoc(env, project, id, fetcher);
  if (!doc) return { id, title: id, ok: false, message: "The site does not have this post." };
  const title = doc.title || id;
  const parts = splitSource(doc.source);
  if (parts.front === null) return { id, title, ok: false, message: "This post has no frontmatter, so it cannot be copied as a draft." };
  const copy = await freeCopyId(env, project, id, fetcher);
  if (!copy) return { id, title, ok: false, message: "No unused id was found for the copy. Rename an earlier copy and try again." };

  let front = setField(parts.front, "title", `${readFields(parts.front).title || id} (copy${copy.n > 1 ? ` ${copy.n}` : ""})`);
  // The site's own copy of the id sits in the file as well; a copy that kept the old one would clash with the original.
  if (/^slug:/m.test(front)) front = setRawKey(front, "slug", copy.id);
  front = setRawKey(front, "draft", "true");
  const source = joinSource({ ...parts, front });
  const outcome = await writeToSite(env, project, viewer, copy.id, { action: "save", source, expectedVersion: null }, fetcher);
  if (!outcome.ok) return { id, title, ok: false, message: outcome.reason === "conflict" ? "The id chosen for the copy was taken while this ran. Nothing was copied." : outcome.message };
  return { id, title, ok: true, message: `Copied as a draft with the id "${copy.id}".`, copyId: copy.id };
}

async function deleteOne(env: Env, project: SiteProject, viewer: Viewer, id: string, fetcher?: typeof fetch): Promise<ItemResult> {
  const outcome = await deleteFromSite(env, project, viewer, id, fetcher);
  if (!outcome.ok) return { id, title: id, ok: false, message: outcome.message };
  return {
    id,
    title: outcome.title || id,
    ok: true,
    message: outcome.recorded ? "Deleted from the site." : "Deleted from the site. Carrel could not save the record of it; tell the Owner.",
  };
}
