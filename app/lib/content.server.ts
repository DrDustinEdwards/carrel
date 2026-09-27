// Every read and write of a site's content that Carrel performs for a person: autosave to D1, and
// the writes it sends through site-api. Roles are checked here, not only in the route, so every
// door (the UI now, MCP tools in stage 5) is held to the same rule.

import type { ContentDoc } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, drafts } from "~/db/schema";
import { indexDoc } from "~/lib/index.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can, type Action, type Role } from "~/lib/roles";
import { siteClient } from "~/lib/sites.server";

export type Draft = { source: string; baseVersion: string | null; updatedAt: string };

export type WriteAction = "save" | "publish" | "schedule" | "unpublish";

export type WriteOutcome =
  | { ok: true; action: WriteAction; version: string; status: ContentDoc["status"]; changeId: string }
  | { ok: false; reason: "conflict"; currentVersion: string | null; message: string }
  | { ok: false; reason: "refused" | "failed"; message: string };

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

/** Enough of a project to check a role on it: a site or a book. Drafts are keyed by project and item either way. */
export type ProjectRole = { id: number; role: Role };

function requireCan(project: { role: Role }, action: Action) {
  if (!can(project.role, action)) forbid();
}

/** A 404 from the site means the item is not there yet, which is how a new post starts. */
export async function readDoc(env: Env, project: SiteProject, itemId: string, fetcher?: typeof fetch) {
  requireCan(project, "read");
  try {
    return await siteClient(env, project.site, fetcher).get(itemId);
  } catch (error) {
    if (error instanceof SiteApiError && error.status === 404) return null;
    throw error;
  }
}

export async function readDraft(db: D1Database, project: ProjectRole, viewer: Viewer, itemId: string) {
  requireCan(project, "read");
  const row = await drizzle(db)
    .select({ source: drafts.source, baseVersion: drafts.baseVersion, updatedAt: drafts.updatedAt })
    .from(drafts)
    .where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, itemId), eq(drafts.personId, viewer.id)))
    .get();
  return row ?? null;
}

/** The working copy is private to the person: an Editor may autosave a live post, never send it. The same for a book's files. */
export async function autosave(
  db: D1Database,
  project: ProjectRole,
  viewer: Viewer,
  itemId: string,
  input: { source: string; baseVersion: string | null },
  now = new Date(),
): Promise<Draft> {
  requireCan(project, "edit");
  const updatedAt = now.toISOString();
  await drizzle(db)
    .insert(drafts)
    .values({ projectId: project.id, itemId, personId: viewer.id, source: input.source, baseVersion: input.baseVersion, updatedAt })
    .onConflictDoUpdate({
      target: [drafts.projectId, drafts.itemId, drafts.personId],
      set: { source: input.source, baseVersion: input.baseVersion, updatedAt },
    });
  return { source: input.source, baseVersion: input.baseVersion, updatedAt };
}

export async function discardDraft(db: D1Database, project: ProjectRole, viewer: Viewer, itemId: string) {
  requireCan(project, "edit");
  await drizzle(db)
    .delete(drafts)
    .where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, itemId), eq(drafts.personId, viewer.id)));
}

/**
 * What a write needs. Saving changes to a published or scheduled item changes the public site, so it
 * is a publish, not an edit: an Editor may save drafts only.
 */
export function actionNeeded(action: WriteAction, current: ContentDoc | null): Action {
  if (action !== "save") return "publish";
  return current && current.status !== "draft" ? "publish" : "edit";
}

export async function writeToSite(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  request:
    | { action: "save"; source: string; expectedVersion: string | null }
    | { action: "publish"; expectedVersion: string; source?: string }
    | { action: "schedule"; expectedVersion: string; publishAt: string; source?: string }
    | { action: "unpublish"; expectedVersion: string },
  fetcher?: typeof fetch,
): Promise<WriteOutcome> {
  // Checked twice: before any request, from the role alone, and again against the item's live state.
  requireCan(project, request.action === "save" ? "edit" : "publish");
  const client = siteClient(env, project.site, fetcher);
  const current = await readDoc(env, project, itemId, fetcher);
  requireCan(project, actionNeeded(request.action, current));

  const changeId = crypto.randomUUID();
  let result;
  try {
    switch (request.action) {
      case "save":
        result = await client.saveDraft(itemId, { source: request.source, expectedVersion: request.expectedVersion, changeId });
        break;
      case "publish":
        result = await client.publish(itemId, { expectedVersion: request.expectedVersion, changeId, source: request.source });
        break;
      case "schedule":
        result = await client.schedule(itemId, {
          expectedVersion: request.expectedVersion,
          changeId,
          publishAt: request.publishAt,
          source: request.source,
        });
        break;
      case "unpublish":
        result = await client.unpublish(itemId, { expectedVersion: request.expectedVersion, changeId });
        break;
    }
  } catch (error) {
    if (error instanceof SiteApiError && error.body?.error === "version-conflict") {
      return {
        ok: false,
        reason: "conflict",
        currentVersion: error.body.currentVersion ?? null,
        message: "The post changed on the site since you opened it. Your text is kept here; reload the site's version to compare before saving.",
      };
    }
    if (error instanceof SiteApiError && error.body?.error === "refused") {
      return { ok: false, reason: "refused", message: error.body.message };
    }
    console.error(JSON.stringify({ write: "failed", itemId, action: request.action, error: String(error) }));
    return { ok: false, reason: "failed", message: "The site did not accept the write. Your text is kept here." };
  }

  await drizzle(env.DB).insert(changes).values({
    id: changeId,
    projectId: project.id,
    itemId,
    personId: viewer.id,
    action: request.action,
    versionBefore: current?.version ?? null,
    versionAfter: result.version,
  });

  // The draft is done once its text reached the site; an unpublish sends no text, so it stays.
  if ("source" in request && request.source !== undefined) {
    await drizzle(env.DB)
      .delete(drafts)
      .where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, itemId), eq(drafts.personId, viewer.id)));
  }

  // The write landed; a failed re-read only leaves the index to the next refresh.
  try {
    const doc = await client.get(itemId);
    await indexDoc(env.DB, project.id, doc);
  } catch (error) {
    console.error(JSON.stringify({ index: "after-write-failed", itemId, error: String(error) }));
  }

  return { ok: true, action: request.action, version: result.version, status: result.status, changeId };
}
