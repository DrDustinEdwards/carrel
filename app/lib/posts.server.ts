// A site's posts list over the content kit (site-api's admin half): Carrel and every site's own admin
// run the same loader and the same intents, and the screen is Capsomer's PostsList. What Carrel adds is
// supplied as the kit's hooks, so no rule here is a second copy of the kit's:
//
// - Roles, from Carrel's: a Reader posts nothing, an Editor tags, duplicates, renames a draft and moves
//   posts to the Trash and back, and only the Owner changes what the public sees (unpublish, reschedule,
//   a live post's tags, address or Trash) or deletes for good. The kit refuses before the site hears it.
// - The authorship record: every write the site carried out is one row in changes, under the change id
//   Carrel sent, with the versions before and after, so the two histories join. A refused write writes
//   nothing. A duplicate is recorded as the save that created the copy, so whoever made it is its Author.
// - The index: each write is read back into Carrel's index of the site, which the editor's links and
//   the AI tools search.
// - Carrel's own state: a post with unsaved changes in Carrel is left alone by a tag change or a
//   rename, a copy never takes an id Carrel already uses, and a row says when AI drafts wait on it.

import { runPostsIntent, type ContentSource, type IntentResult } from "@dustinedwards/site-api/admin";
import type { SiteClient } from "@dustinedwards/site-api/client";
import { drizzle } from "drizzle-orm/d1";

import { changes } from "~/db/schema";
import { readDraft } from "~/lib/content.server";
import { indexDoc, refreshIndex, removeFromIndex } from "~/lib/index.server";
import type { Viewer } from "~/lib/people.server";
import { answer, kitBase } from "~/lib/kit.server";
import { requireSiteProject, type SiteProject } from "~/lib/projects.server";
import { siteClient, siteUnreachable } from "~/lib/sites.server";
import { waitingWork } from "~/lib/waiting.server";

/** The authorship record's action for each kind the kit records. Tags are a save of the post, as an editor's save is. */
const ACTIONS: Record<string, (typeof changes.$inferInsert)["action"]> = {
  "post-tag-add": "save",
  "post-tag-remove": "save",
  "post-duplicate": "save",
  "post-unpublish": "unpublish",
  "post-republish": "publish",
  "post-reschedule": "schedule",
  "post-cancel-schedule": "unschedule",
  "post-delete": "content-delete",
  "post-trash": "content-trash",
  "post-restore": "content-restore",
  "post-rename": "content-rename",
};

type Write = { itemId: string; renamedFrom: string | null; versionBefore: string | null; versionAfter: string | null };

const WRITES = ["saveDraft", "publish", "schedule", "cancelSchedule", "unpublish", "delete", "setTags", "rename", "trash", "restore"] as const;

/**
 * The site's client, noting each write it sends by its change id: the kit's record hook names only the
 * kind, the ids and the change id, and the record also keeps the versions and a rename's old id.
 */
function noting(client: SiteClient, writes: Map<string, Write>): SiteClient {
  const wrapped: Record<string, unknown> = { ...client };
  for (const name of WRITES) {
    const send = client[name] as (id: string, input: { changeId: string; expectedVersion?: string | null; newId?: string }) => Promise<{ version?: string }>;
    wrapped[name] = async (id: string, input: { changeId: string; expectedVersion?: string | null; newId?: string }) => {
      const written = await send(id, input);
      writes.set(input.changeId, { itemId: input.newId ?? id, renamedFrom: input.newId ? id : null, versionBefore: input.expectedVersion ?? null, versionAfter: written.version ?? null });
      return written;
    };
  }
  return wrapped as SiteClient;
}

const editorHref = (slug: string, id: string) => `/p/${encodeURIComponent(slug)}/e/${encodeURIComponent(id)}`;

/** One site's posts, as the content kit reads and writes them for this person. */
export function postsSource(env: Env, project: SiteProject, viewer: Viewer, fetcher?: typeof fetch): ContentSource {
  const client = siteClient(env, project.site, fetcher);
  const writes = new Map<string, Write>();
  return {
    ...kitBase(env, project),
    client: noting(client, writes),
    editorHref: (id) => editorHref(project.slug, id),
    async notes(ids) {
      const waiting = new Map((await waitingWork(env.DB, project, viewer)).map((w) => [w.itemId, w.aiDrafts]));
      const notes: Record<string, { text: string; tone: "info" }[]> = {};
      for (const id of ids) {
        const n = waiting.get(id) ?? 0;
        if (n > 0) notes[id] = [{ text: n === 1 ? "1 AI draft waiting" : `${n} AI drafts waiting`, tone: "info" }];
      }
      return notes;
    },
    // A tag change or a rename writes the site's copy, and the person's unsaved one would then be stale or stranded.
    async hold(intent, id) {
      if (intent !== "tag-add" && intent !== "tag-remove" && intent !== "rename") return null;
      return (await readDraft(env.DB, project, viewer, id))
        ? `This post has changes in Carrel nobody has saved. Open it and ${intent === "rename" ? "save or discard them before renaming it" : "change the tags there"}, so they are not lost.`
        : null;
    },
    async taken(id) {
      const used = await env.DB.prepare(
        `SELECT 1 AS used FROM drafts WHERE project_id = ?1 AND item_id = ?2
         UNION ALL SELECT 1 FROM ai_drafts WHERE project_id = ?1 AND item_id = ?2
         UNION ALL SELECT 1 FROM site_items WHERE project_id = ?1 AND item_id = ?2 LIMIT 1`,
      )
        .bind(project.id, id)
        .first();
      return used !== null;
    },
    async record({ kind, changeId }) {
      const action = ACTIONS[kind];
      const write = writes.get(changeId);
      if (!action || !write) return;
      await drizzle(env.DB).insert(changes).values({
        id: changeId,
        projectId: project.id,
        itemId: write.itemId,
        personId: viewer.id,
        action,
        versionBefore: write.versionBefore,
        versionAfter: write.versionAfter,
        renamedFrom: write.renamedFrom,
      });
      // The index is a cache; a failed read-back leaves it to the next refresh.
      try {
        if (write.renamedFrom) await removeFromIndex(env.DB, project.id, write.renamedFrom);
        if (action === "content-delete" || action === "content-trash") await removeFromIndex(env.DB, project.id, write.itemId);
        else await indexDoc(env.DB, project.id, await client.get(write.itemId));
      } catch (error) {
        console.error(JSON.stringify({ index: "after-write-failed", itemId: write.itemId, error: String(error) }));
      }
    },
  };
}

/**
 * One posted intent, as the kit runs it. The same for the list's forms with no script and the posts
 * endpoint's. Refresh, the list's one toolbar action of Carrel's own, reads the site into the index.
 */
export async function runIntent(env: Env, viewer: Viewer, slug: string | undefined, form: FormData): Promise<IntentResult> {
  const project = await requireSiteProject(env.DB, viewer, slug, "read");
  return answer(async () => {
    if (form.get("intent") === "refresh") {
      const done = await refreshIndex(env, { id: project.id, site: project.site });
      return { ok: true, message: `${done.listed} posts listed, ${done.fetched} read in full${done.pending > 0 ? `, ${done.pending} more on the next refresh` : ""}.` };
    }
    return await runPostsIntent(postsSource(env, project, viewer), form);
  }, siteUnreachable);
}
