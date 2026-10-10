// The one view's index of a site's content: what the site reports, cached in D1 with FTS5 over title
// and body, refreshed on every save and by the 15-minute cron. The site stays the authority.

import type { ContentDoc, ContentStatus, ContentSummary } from "@dustinedwards/site-api";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { siteItems } from "~/db/schema";
import { siteClient, type SiteId } from "~/lib/sites.server";

/**
 * Workers Paid allows 10,000 subrequests per invocation by default, and a D1 call counts as one
 * (developers.cloudflare.com/workers/platform/limits/#subrequests, checked 2026-09-27; Workers Free
 * stays at 50). Carrel is on Workers Paid.
 */
export const SUBREQUEST_LIMIT = 10_000;

/**
 * What one site's refresh may spend: a tenth of the limit, so the cron's other work in the same
 * invocation (the health check, other sites' refreshes) always has room.
 */
export const REFRESH_SUBREQUEST_BUDGET = SUBREQUEST_LIMIT / 10;

const PAGE_SIZE = 200;
export const MAX_PAGES = 10;

/**
 * Bodies read per refresh. A refresh costs at most MAX_PAGES list calls, two D1 calls (the known
 * rows and the summaries' batch), and two per body (its fetch and its batch): 12 + 2 x 200 = 412,
 * inside REFRESH_SUBREQUEST_BUDGET. The rest are reported as pending and read on the next run.
 */
export const MAX_BODY_FETCHES = 200;

/** The most subrequests one refresh can make, from the counts above. */
export const REFRESH_MAX_SUBREQUESTS = MAX_PAGES + 2 + 2 * MAX_BODY_FETCHES;

export type IndexedItem = {
  itemId: string;
  kind: string;
  title: string;
  status: ContentStatus;
  path: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
};

type ProjectRef = { id: number; site: SiteId };

function summaryRow(projectId: number, item: ContentSummary, syncedAt: string) {
  return {
    projectId,
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    path: item.path,
    publishAt: item.publishAt,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    syncedAt,
  };
}

function writeBody(db: D1Database, projectId: number, itemId: string, title: string, body: string) {
  return [
    db.prepare("DELETE FROM site_items_fts WHERE project_id = ? AND item_id = ?").bind(projectId, itemId),
    db
      .prepare("INSERT INTO site_items_fts (project_id, item_id, title, body) VALUES (?, ?, ?, ?)")
      .bind(projectId, itemId, title, body),
  ];
}

/** Indexes one item from a document already in hand, as after a save: no extra request to the site. */
export async function indexDoc(db: D1Database, projectId: number, doc: ContentDoc, now = new Date()): Promise<void> {
  const row = summaryRow(projectId, doc, now.toISOString());
  const d = drizzle(db);
  await d
    .insert(siteItems)
    .values({ ...row, bodyUpdatedAt: doc.updatedAt ?? "" })
    .onConflictDoUpdate({
      target: [siteItems.projectId, siteItems.itemId],
      set: { ...row, bodyUpdatedAt: doc.updatedAt ?? "" },
    });
  await db.batch(writeBody(db, projectId, doc.id, doc.title, doc.source));
}

/** Drops one item from the index after the site deleted it. The index is a cache; the site stays the authority. */
export async function removeFromIndex(db: D1Database, projectId: number, itemId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM site_items WHERE project_id = ? AND item_id = ?").bind(projectId, itemId),
    db.prepare("DELETE FROM site_items_fts WHERE project_id = ? AND item_id = ?").bind(projectId, itemId),
  ]);
}

export type RefreshResult = { listed: number; fetched: number; removed: number; pending: number };

/**
 * Lists every item, upserts the summaries, drops items the site no longer lists, and fetches the
 * body of up to MAX_BODY_FETCHES items whose updatedAt moved since their body was read. The rest are
 * reported as pending and caught up on the next run.
 */
export async function refreshIndex(
  env: Env,
  project: ProjectRef,
  fetcher?: typeof fetch,
  now = new Date(),
): Promise<RefreshResult> {
  const client = siteClient(env, project.site, fetcher);
  const items: ContentSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.list({ limit: PAGE_SIZE, cursor });
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const d = drizzle(env.DB);
  const syncedAt = now.toISOString();
  const known = new Map(
    (
      await d
        .select({ itemId: siteItems.itemId, bodyUpdatedAt: siteItems.bodyUpdatedAt })
        .from(siteItems)
        .where(eq(siteItems.projectId, project.id))
        .all()
    ).map((r) => [r.itemId, r.bodyUpdatedAt]),
  );

  const listed = new Set(items.map((i) => i.id));
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    const row = summaryRow(project.id, item, syncedAt);
    statements.push(
      env.DB.prepare(
        `INSERT INTO site_items (project_id, item_id, kind, title, status, path, publish_at, published_at, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, item_id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
           status = excluded.status, path = excluded.path, publish_at = excluded.publish_at,
           published_at = excluded.published_at, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
      ).bind(
        row.projectId, row.itemId, row.kind, row.title, row.status, row.path,
        row.publishAt, row.publishedAt, row.updatedAt, row.syncedAt,
      ),
    );
  }
  const gone = [...known.keys()].filter((id) => !listed.has(id));
  for (const itemId of gone) {
    statements.push(
      env.DB.prepare("DELETE FROM site_items WHERE project_id = ? AND item_id = ?").bind(project.id, itemId),
      env.DB.prepare("DELETE FROM site_items_fts WHERE project_id = ? AND item_id = ?").bind(project.id, itemId),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  // body_updated_at is null until a body is read, and "" once read from an item with no updatedAt,
  // so a site that omits updatedAt is read once rather than on every run.
  const stale = items.filter((i) => {
    const readAt = known.get(i.id);
    return readAt === undefined || readAt === null || readAt !== (i.updatedAt ?? "");
  });
  const due = stale.slice(0, MAX_BODY_FETCHES);
  for (const item of due) {
    const doc = await client.get(item.id);
    await env.DB.batch([
      ...writeBody(env.DB, project.id, doc.id, doc.title, doc.source),
      env.DB.prepare("UPDATE site_items SET body_updated_at = ? WHERE project_id = ? AND item_id = ?").bind(
        doc.updatedAt ?? "",
        project.id,
        doc.id,
      ),
    ]);
  }

  return { listed: items.length, fetched: due.length, removed: gone.length, pending: stale.length - due.length };
}

/**
 * The search as an FTS5 expression: each word quoted (so punctuation is text, never syntax), all
 * required, the last one a prefix so results follow typing.
 */
export function ftsQuery(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words
    .slice(0, 8)
    .map((w, i, all) => `"${w.replaceAll('"', '""')}"${i === all.length - 1 ? "*" : ""}`)
    .join(" ");
}

export type Filters = { q?: string; status?: ContentStatus; kind?: string };

/**
 * The kinds Carrel presents as writing, read from the site's own metadata rather than named here:
 * site-api reports a kind only as a free string. A kind is writing when any of its items has a page
 * on the site (a path) or is not yet published. A data kind (the dustinedwards lab registry:
 * equipment, reagent, primer, strain) is published with no page at all, so it stays in the index but
 * out of every writing list and its count, whatever it is called. A site-api field that says
 * "writing" would replace this rule.
 */
function writingKinds(projectId: number): SQL {
  return sql`${siteItems.kind} IN (SELECT kind FROM site_items WHERE project_id = ${projectId} AND (path IS NOT NULL OR status != 'published'))`;
}

export async function searchItems(db: D1Database, projectId: number, filters: Filters): Promise<IndexedItem[]> {
  const conditions: SQL[] = [eq(siteItems.projectId, projectId), writingKinds(projectId)];
  if (filters.status) conditions.push(eq(siteItems.status, filters.status));
  if (filters.kind) conditions.push(eq(siteItems.kind, filters.kind));
  const match = filters.q ? ftsQuery(filters.q) : null;
  if (filters.q && !match) return [];
  if (match) {
    conditions.push(
      sql`${siteItems.itemId} IN (SELECT item_id FROM site_items_fts WHERE site_items_fts MATCH ${match} AND project_id = ${projectId})`,
    );
  }
  return drizzle(db)
    .select({
      itemId: siteItems.itemId,
      kind: siteItems.kind,
      title: siteItems.title,
      status: siteItems.status,
      path: siteItems.path,
      publishAt: siteItems.publishAt,
      publishedAt: siteItems.publishedAt,
      updatedAt: siteItems.updatedAt,
    })
    .from(siteItems)
    .where(and(...conditions))
    .orderBy(desc(siteItems.updatedAt), asc(siteItems.itemId))
    .limit(500)
    .all();
}

export async function kindsIn(db: D1Database, projectId: number): Promise<string[]> {
  const rows = await drizzle(db)
    .selectDistinct({ kind: siteItems.kind })
    .from(siteItems)
    .where(and(eq(siteItems.projectId, projectId), writingKinds(projectId)))
    .orderBy(asc(siteItems.kind))
    .all();
  return rows.map((r) => r.kind);
}

/**
 * Where each item lives on the site, for links written in the editor: its own path when the site
 * gives one, otherwise the path its published siblings of the same kind follow (a draft post takes
 * the address the site's published posts have, with its own id). An item whose kind shows no such
 * pattern has no known address yet, and is left out of the link targets.
 */
export function sitePaths(items: readonly Pick<IndexedItem, "itemId" | "kind" | "path">[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const i of items) {
    if (i.path && !prefixes.has(i.kind) && i.path.endsWith(`/${i.itemId}`)) prefixes.set(i.kind, i.path.slice(0, -i.itemId.length));
  }
  const paths = new Map<string, string>();
  for (const i of items) {
    const prefix = prefixes.get(i.kind);
    const path = i.path ?? (prefix ? `${prefix}${i.itemId}` : null);
    if (path) paths.set(i.itemId, path);
  }
  return paths;
}
