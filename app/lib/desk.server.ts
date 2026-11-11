// What Desk's Home, Writing list, header inbox and search read across every project the viewer may open.
// One place, so the count in the header and the rows on Home cannot disagree. Everything here reads D1
// (the index of each site's posts, the drafts, the flags, the social queue); only the mention counts ask
// the sites, and they are separate so a slow site never holds the page.

import { and, count, desc, eq, gt, inArray, isNotNull, lte, min, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  aiDrafts,
  authorship,
  drafts,
  findings,
  needLater,
  projects,
  siteItems,
  socialPosts,
} from "~/db/schema";
import { mentionsSource, unreachable } from "~/lib/mentions.server";
import type { Viewer, VisibleProject } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { loadMentions } from "@dustinedwards/site-api/admin";
import { isSiteId, siteConnection } from "~/lib/sites.server";
import type { Need as QueueNeed } from "capsomer/behavior/attention-list";

export type NeedGroup = "ai" | "due" | "flags" | "mentions" | "approvals";
/** One row of Home's work queue: Capsomer's Need (attention-list), grouped by Carrel's kinds. Set aside with
 * Later, a need is off Home's list and out of the header's count until it comes back. */
export type Need = QueueNeed<NeedGroup> & { detail: string };

const postHref = (slug: string, itemId: string) =>
  `/p/${encodeURIComponent(slug)}/e/${encodeURIComponent(itemId)}`;

/** The projects' ids and slugs by id, for turning a row's project id into a name and a link. */
function byId(list: VisibleProject[]) {
  return new Map(list.map((p) => [p.id, p]));
}

/**
 * The work waiting on this person that D1 knows about: AI drafts, posts due to go out, open flags and
 * (the Owner's) social posts awaiting approval. Oldest first within a group.
 */
export async function needsYou(
  db: D1Database,
  viewer: Viewer,
  visible: VisibleProject[],
  now = new Date(),
): Promise<Need[]> {
  const known = byId(visible);
  const ids = visible.map((p) => p.id);
  if (ids.length === 0) return [];
  const d = drizzle(db);
  const soon = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  const [ai, due, flags, awaiting, later] = await Promise.all([
    d
      .select({
        projectId: aiDrafts.projectId,
        n: count(),
        since: min(aiDrafts.createdAt),
        first: min(aiDrafts.id),
      })
      .from(aiDrafts)
      .where(and(eq(aiDrafts.personId, viewer.id), inArray(aiDrafts.projectId, ids)))
      .groupBy(aiDrafts.projectId)
      .all(),
    d
      .select({
        projectId: siteItems.projectId,
        itemId: siteItems.itemId,
        title: siteItems.title,
        at: siteItems.publishAt,
      })
      .from(siteItems)
      .where(
        and(
          inArray(siteItems.projectId, ids),
          eq(siteItems.status, "scheduled"),
          isNotNull(siteItems.publishAt),
          lte(siteItems.publishAt, soon),
        ),
      )
      .orderBy(siteItems.publishAt)
      .limit(20)
      .all(),
    d
      .select({ projectId: findings.projectId, n: count(), since: min(findings.createdAt) })
      .from(findings)
      .where(and(eq(findings.status, "open"), inArray(findings.projectId, ids)))
      .groupBy(findings.projectId)
      .all(),
    viewer.isOwner
      ? d
          .select({ n: count(), since: min(socialPosts.createdAt) })
          .from(socialPosts)
          .where(inArray(socialPosts.status, ["awaiting", "held"]))
          .all()
      : Promise.resolve([] as { n: number; since: string | null }[]),
    laterMarks(db, viewer, now),
  ]);

  const out: Need[] = [];
  for (const row of ai) {
    const p = known.get(row.projectId);
    if (!p) continue;
    // The Writing list, narrowed to this site's posts that have AI drafts waiting beside the person's own.
    const href = `/writing?waiting=ai&site=${encodeURIComponent(p.slug)}`;
    out.push({
      id: `ai-${p.id}`,
      group: "ai",
      urgency: "waiting",
      title: row.n === 1 ? "1 AI draft waits for review" : `${row.n} AI drafts wait for review`,
      detail: p.name,
      action: { label: "Review", href },
      at: row.since,
    });
  }
  for (const row of due) {
    const p = known.get(row.projectId);
    if (!p) continue;
    const overdue = row.at !== null && row.at <= now.toISOString();
    out.push({
      id: `due-${p.id}-${row.itemId}`,
      group: "due",
      urgency: overdue ? "blocking" : "waiting",
      title: `“${row.title || row.itemId}” ${overdue ? "was due to publish and has not" : "publishes within a day"}`,
      detail: p.name,
      action: { label: "Open", href: postHref(p.slug, row.itemId) },
      at: row.at,
    });
  }
  for (const row of flags) {
    const p = known.get(row.projectId);
    if (!p || !can(p.role, "read")) continue;
    out.push({
      id: `flags-${p.id}`,
      group: "flags",
      urgency: "waiting",
      title: row.n === 1 ? "1 open flag" : `${row.n} open flags`,
      detail: p.name,
      action: { label: "Fix", href: p.kind === "book" ? `/b/${p.slug}` : `/p/${p.slug}/flags` },
      at: row.since,
    });
  }
  const queue = awaiting[0];
  if (queue && queue.n > 0)
    out.push({
      id: "approvals",
      group: "approvals",
      urgency: "waiting",
      title:
        queue.n === 1 ? "1 social post awaits approval" : `${queue.n} social posts await approval`,
      detail: "Social",
      action: { label: "Approve", href: "/social" },
      at: queue.since,
    });
  return markLater(out, later);
}

/** Pending webmentions per site, asked of each site in turn and never thrown: a site that does not answer is left out. */
export async function mentionNeeds(
  env: Env,
  viewer: Viewer,
  visible: VisibleProject[],
): Promise<Need[]> {
  if (!viewer.isOwner) return [];
  const sites = await drizzle(env.DB)
    .select({ id: projects.id, site: projects.site })
    .from(projects)
    .where(isNotNull(projects.site))
    .all();
  const known = byId(visible);
  const later = await laterMarks(env.DB, viewer);
  const found = await Promise.all(
    sites.map(async (s): Promise<Need | null> => {
      const p = known.get(s.id);
      if (!p || !isSiteId(s.site) || siteConnection(env, s.site).state !== "connected") return null;
      try {
        const kit = await loadMentions(
          mentionsSource(
            env,
            { id: p.id, slug: p.slug, name: p.name, role: p.role, site: s.site },
            viewer,
          ),
          { status: "pending" },
        );
        const n = kit.counts.pending + kit.counts.unverified;
        if (!kit.offers.mentions || n === 0) return null;
        return {
          id: `mentions-${p.id}`,
          group: "mentions",
          urgency: "waiting",
          title: n === 1 ? "1 mention waits for a decision" : `${n} mentions wait for a decision`,
          detail: p.name,
          action: { label: "Decide", href: `/p/${p.slug}/mentions` },
          at: null,
        };
      } catch (error) {
        if (unreachable(error) === null) throw error;
        return null;
      }
    }),
  );
  return markLater(
    found.filter((n): n is Need => n !== null),
    later,
  );
}

type LaterMark = { title: string; until: string };

/** The rows this person set aside that have not come back yet, by need id. */
async function laterMarks(
  db: D1Database,
  viewer: Viewer,
  now = new Date(),
): Promise<Map<string, LaterMark>> {
  const rows = await drizzle(db)
    .select({ needId: needLater.needId, title: needLater.title, until: needLater.until })
    .from(needLater)
    .where(and(eq(needLater.personId, viewer.id), gt(needLater.until, now.toISOString())))
    .all();
  return new Map(rows.map((r) => [r.needId, { title: r.title, until: r.until }]));
}

/** A need set aside stays aside only while it reads as it did then: another draft or a post now overdue brings it back. */
function markLater(needs: Need[], marks: Map<string, LaterMark>): Need[] {
  return needs.map((n) => {
    const mark = marks.get(n.id);
    return mark && mark.title === n.title ? { ...n, later: mark.until } : n;
  });
}

const MAX_NEED_ID = 200;
const MAX_TITLE = 500;

/** Sets one of this person's needs aside until `until`, keeping the title it had, and clears their marks that have come back. */
export async function setLater(
  db: D1Database,
  viewer: Viewer,
  need: { id: string; title: string },
  until: string,
  now = new Date(),
): Promise<void> {
  if (!need.id || need.id.length > MAX_NEED_ID || need.title.length > MAX_TITLE)
    throw new Response("That row cannot be set aside.", { status: 400 });
  const d = drizzle(db);
  await d.batch([
    d
      .delete(needLater)
      .where(and(eq(needLater.personId, viewer.id), lte(needLater.until, now.toISOString()))),
    d
      .insert(needLater)
      .values({ personId: viewer.id, needId: need.id, title: need.title, until })
      .onConflictDoUpdate({
        target: [needLater.personId, needLater.needId],
        set: { title: need.title, until, createdAt: now.toISOString() },
      }),
  ]);
}

/** Brings a row this person set aside back to Home at once. */
export async function bringBack(db: D1Database, viewer: Viewer, needId: string): Promise<void> {
  await drizzle(db)
    .delete(needLater)
    .where(and(eq(needLater.personId, viewer.id), eq(needLater.needId, needId)));
}

export type Continue = { projectName: string; title: string; href: string; at: string };

/** The last things this person had open in their own drafts, newest first. */
export async function continueWriting(
  db: D1Database,
  viewer: Viewer,
  visible: VisibleProject[],
  limit = 3,
): Promise<Continue[]> {
  const known = byId(visible);
  const rows = await drizzle(db)
    .select({
      projectId: drafts.projectId,
      itemId: drafts.itemId,
      source: drafts.source,
      at: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.personId, viewer.id))
    .orderBy(desc(drafts.updatedAt))
    .limit(limit * 3)
    .all();
  const out: Continue[] = [];
  for (const r of rows) {
    const p = known.get(r.projectId);
    if (!p || p.kind !== "site") continue;
    const title = /^title:\s*(.+)$/m.exec(r.source)?.[1]?.replace(/^["']|["']$/g, "") ?? r.itemId;
    out.push({ projectName: p.name, title, href: postHref(p.slug, r.itemId), at: r.at });
    if (out.length === limit) break;
  }
  return out;
}

/** Words typed in the last 24 hours in each project, this person's own typing only (as the progress chart counts). */
export async function typedToday(
  db: D1Database,
  viewer: Viewer,
  visible: VisibleProject[],
  now = new Date(),
): Promise<{ name: string; words: number; href: string }[]> {
  const known = byId(visible);
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const rows = await drizzle(db)
    .select({
      projectId: authorship.projectId,
      typed: sql<number>`coalesce(sum(${authorship.wordsTyped}), 0)`,
    })
    .from(authorship)
    .where(
      and(
        eq(authorship.personId, viewer.id),
        sql`${authorship.client} is null`,
        isNotNull(authorship.wordsTyped),
        sql`${authorship.createdAt} >= ${since}`,
      ),
    )
    .groupBy(authorship.projectId)
    .all();
  return rows
    .flatMap((r) => {
      const p = known.get(r.projectId);
      return p && r.typed > 0
        ? [
            {
              name: p.name,
              words: r.typed,
              href: p.kind === "book" ? `/b/${p.slug}` : `/p/${p.slug}`,
            },
          ]
        : [];
    })
    .sort((a, b) => b.words - a.words);
}

export type WritingRow = {
  projectId: number;
  site: string;
  siteSlug: string;
  itemId: string;
  kind: string;
  title: string;
  status: "draft" | "scheduled" | "published";
  at: string | null;
  href: string;
};

export type WritingQuery = { site?: string; status?: string; q?: string; kind?: string };

/**
 * Every post and page of every site the viewer may read, from the index in D1 (a data kind such as the
 * lab registry has no page and is left out: published with no path). Newest change first.
 */
export async function writingRows(
  db: D1Database,
  visible: VisibleProject[],
  query: WritingQuery,
  limit = 200,
): Promise<{
  rows: WritingRow[];
  counts: Record<"all" | "draft" | "scheduled" | "published", number>;
}> {
  const sites = visible.filter((p) => p.kind === "site" && can(p.role, "read"));
  const scoped = query.site ? sites.filter((p) => p.slug === query.site) : sites;
  const empty = { all: 0, draft: 0, scheduled: 0, published: 0 };
  if (scoped.length === 0) return { rows: [], counts: empty };
  const d = drizzle(db);
  const ids = scoped.map((p) => p.id);
  const words = (query.q?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6);
  const filters = [
    inArray(siteItems.projectId, ids),
    sql`not (${siteItems.status} = 'published' and ${siteItems.path} is null)`,
    ...(query.kind ? [eq(siteItems.kind, query.kind)] : []),
    ...words.map(
      (w) =>
        sql`(lower(${siteItems.title}) like ${`%${w.replace(/[\\%_]/g, "\\$&")}%`} escape '\\' or lower(${siteItems.itemId}) like ${`%${w.replace(/[\\%_]/g, "\\$&")}%`} escape '\\')`,
    ),
  ];
  const all = await d
    .select({
      projectId: siteItems.projectId,
      itemId: siteItems.itemId,
      kind: siteItems.kind,
      title: siteItems.title,
      status: siteItems.status,
      at: sql<
        string | null
      >`coalesce(${siteItems.updatedAt}, ${siteItems.publishedAt}, ${siteItems.syncedAt})`,
    })
    .from(siteItems)
    .where(and(...filters))
    .orderBy(
      desc(sql`coalesce(${siteItems.updatedAt}, ${siteItems.publishedAt}, ${siteItems.syncedAt})`),
    )
    .limit(2000)
    .all();
  const known = byId(scoped);
  const counts = { ...empty };
  const rows: WritingRow[] = [];
  for (const r of all) {
    const p = known.get(r.projectId);
    if (!p) continue;
    counts.all += 1;
    counts[r.status] += 1;
    if (query.status && query.status !== "all" && r.status !== query.status) continue;
    if (rows.length >= limit) continue;
    rows.push({
      projectId: p.id,
      site: p.name,
      siteSlug: p.slug,
      itemId: r.itemId,
      kind: r.kind,
      title: r.title || r.itemId,
      status: r.status,
      at: r.at,
      href: postHref(p.slug, r.itemId),
    });
  }
  return { rows, counts };
}

/** The header search: posts on every site and every book whose title has every word typed. */
export async function searchEverything(
  db: D1Database,
  visible: VisibleProject[],
  q: string,
): Promise<{ id: string; label: string; group: string; href: string; hint?: string }[]> {
  const { rows } = await writingRows(db, visible, { q }, 8);
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const books = visible
    .filter((p) => p.kind === "book" && words.every((w) => p.name.toLowerCase().includes(w)))
    .slice(0, 4);
  return [
    ...rows.map((r) => ({
      id: `post-${r.projectId}-${r.itemId}`,
      label: r.title,
      group: "Posts",
      href: r.href,
      hint: r.site,
    })),
    ...books.map((b) => ({
      id: `book-${b.id}`,
      label: b.name,
      group: "Books",
      href: `/b/${b.slug}`,
      hint: "Book",
    })),
  ];
}
