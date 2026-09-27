// What AI sessions may do beyond what the buttons do, and the rules around it (design decision 2 and
// section 5, "MCP tools"). The writes still go through content.server.ts, the same functions as the
// buttons, so every role rule applies unchanged; this adds the AI-only rules on top:
//
// - an AI session is an AI client acting for a person, known by the door it came through;
// - a reviewer (another company's agent) reads and flags, and never writes text or publishes;
// - an AI draft is saved beside the person's own draft, never over it or to the site;
// - publish is the Owner's own sessions only, refused while any flag on the item is open, recorded
//   as "published by <client> on Dustin's instruction", and emailed to Dustin with an unpublish link.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts, aiPublications, findings, siteItems } from "~/db/schema";
import { readDoc, writeToSite, type ProjectRole, type WriteOutcome } from "~/lib/content.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";
import { draftForEvent, draftSocialPost } from "~/lib/social/queue.server";

/**
 * An AI client acting for a person, known by the door it came through: the person the OAuth grant
 * belongs to, and the client that holds the grant (its CIMD name), credited on every change.
 */
export type AiSession = { viewer: Viewer; client: string };

/** A refusal an AI tool reports back to the client as its answer, never a crash. */
export class AiRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRefusal";
  }
}

// ---------- flags on an item

export type ItemFinding = {
  id: number;
  check: string;
  message: string;
  excerpt: string | null;
  status: "open" | "dismissed";
  createdAt: string;
};

export async function itemFindings(db: D1Database, project: ProjectRole, itemId: string): Promise<ItemFinding[]> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  return drizzle(db)
    .select({
      id: findings.id,
      check: findings.checkName,
      message: findings.message,
      excerpt: findings.excerpt,
      status: findings.status,
      createdAt: findings.createdAt,
    })
    .from(findings)
    .where(and(eq(findings.projectId, project.id), eq(findings.path, itemId)))
    .orderBy(desc(findings.createdAt), desc(findings.id))
    .all();
}

async function fingerprint(parts: (string | null)[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A flag from an AI session, a reviewer's above all (design B6: reviewers write findings, never
 * text). Anyone who may comment may flag. The same flag twice is one flag.
 */
export async function addFinding(
  db: D1Database,
  project: ProjectRole,
  session: AiSession,
  itemId: string,
  input: { message: string; excerpt?: string | null },
): Promise<{ id: number; duplicate: boolean }> {
  if (!can(project.role, "comment")) throw new AiRefusal("You may not flag anything on this project.");
  const message = input.message.trim();
  if (!message || message.length > 2000) throw new AiRefusal("A flag needs a message of up to 2,000 characters.");
  const excerpt = input.excerpt?.trim() || null;
  const check = session.viewer.isReviewer ? "review" : "ai";
  const full = `${message} (from ${session.client})`;
  const key = await fingerprint([check, full, excerpt]);
  const d = drizzle(db);
  const inserted = await d
    .insert(findings)
    .values({ projectId: project.id, path: itemId, checkName: check, message: full, excerpt, fingerprint: key })
    .onConflictDoNothing()
    .returning({ id: findings.id });
  if (inserted[0]) return { id: inserted[0].id, duplicate: false };
  const existing = await d
    .select({ id: findings.id })
    .from(findings)
    .where(and(eq(findings.projectId, project.id), eq(findings.path, itemId), eq(findings.fingerprint, key)))
    .get();
  return { id: existing!.id, duplicate: true };
}

export type ProjectFlag = ItemFinding & { itemId: string; title: string | null; onSite: boolean };

/**
 * Every flag on a site project, open first then newest first, including flags on items the site does
 * not have (a proof item, a post since deleted), which no editor page can reach. `onSite` says whether
 * Carrel's index of the site has the item.
 */
export async function projectFlags(db: D1Database, project: ProjectRole): Promise<ProjectFlag[]> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  const rows = await drizzle(db)
    .select({
      id: findings.id,
      itemId: findings.path,
      check: findings.checkName,
      message: findings.message,
      excerpt: findings.excerpt,
      status: findings.status,
      createdAt: findings.createdAt,
      title: siteItems.title,
    })
    .from(findings)
    .leftJoin(siteItems, and(eq(siteItems.projectId, findings.projectId), eq(siteItems.itemId, findings.path)))
    .where(eq(findings.projectId, project.id))
    .orderBy(asc(sql`${findings.status} = 'dismissed'`), desc(findings.createdAt), desc(findings.id))
    .all();
  return rows.map((r) => ({ ...r, onSite: r.title !== null }));
}

/** Checks and reviewers flag; a person decides. Dismissing clears a flag for publish, so it is the Owner's. */
export async function dismissItemFinding(db: D1Database, project: ProjectRole, viewer: Viewer, itemId: string, id: number, now = new Date()) {
  if (!can(project.role, "publish")) throw new Response("Forbidden", { status: 403 });
  const result = await drizzle(db)
    .update(findings)
    .set({ status: "dismissed", dismissedBy: viewer.id, dismissedAt: now.toISOString() })
    .where(and(eq(findings.id, id), eq(findings.projectId, project.id), eq(findings.path, itemId)))
    .returning({ id: findings.id });
  if (result.length === 0) throw new Response("Not found", { status: 404 });
}

// ---------- AI drafts, beside the person's own

export async function saveAiDraft(
  env: Env,
  project: SiteProject,
  session: AiSession,
  itemId: string,
  input: { source: string; note?: string },
  fetcher?: typeof fetch,
): Promise<{ id: number; baseVersion: string | null }> {
  if (session.viewer.isReviewer) throw new AiRefusal("A reviewer flags; it does not write text. Use add_finding.");
  if (!can(project.role, "edit")) throw new AiRefusal("You may not write drafts on this project.");
  if (!input.source.trim()) throw new AiRefusal("The draft is empty.");
  let baseVersion: string | null = null;
  try {
    baseVersion = (await readDoc(env, project, itemId, fetcher))?.version ?? null;
  } catch {
    // The site not answering does not stop a draft that lives only in Carrel.
  }
  const [row] = await drizzle(env.DB)
    .insert(aiDrafts)
    .values({
      projectId: project.id,
      itemId,
      personId: session.viewer.id,
      client: session.client,
      source: input.source.replace(/\r\n/g, "\n"),
      baseVersion,
      note: (input.note ?? "").trim().slice(0, 500),
    })
    .returning({ id: aiDrafts.id });
  return { id: row!.id, baseVersion };
}

export type AiDraftSummary = { id: number; client: string; note: string; createdAt: string; baseVersion: string | null; words: number };

/** The AI drafts a person's own sessions saved for this item, newest first. Private to the person, as drafts are. */
export async function listAiDrafts(db: D1Database, project: ProjectRole, viewer: Viewer, itemId: string): Promise<AiDraftSummary[]> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  const rows = await drizzle(db)
    .select({ id: aiDrafts.id, client: aiDrafts.client, note: aiDrafts.note, createdAt: aiDrafts.createdAt, baseVersion: aiDrafts.baseVersion, source: aiDrafts.source })
    .from(aiDrafts)
    .where(and(eq(aiDrafts.projectId, project.id), eq(aiDrafts.itemId, itemId), eq(aiDrafts.personId, viewer.id)))
    .orderBy(desc(aiDrafts.createdAt), desc(aiDrafts.id))
    .all();
  return rows.map(({ source, ...r }) => ({ ...r, words: source.split(/\s+/).filter(Boolean).length }));
}

export async function readAiDraft(db: D1Database, project: ProjectRole, viewer: Viewer, itemId: string, id: number) {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  const row = await drizzle(db)
    .select()
    .from(aiDrafts)
    .where(and(eq(aiDrafts.id, id), eq(aiDrafts.projectId, project.id), eq(aiDrafts.itemId, itemId), eq(aiDrafts.personId, viewer.id)))
    .get();
  if (!row) throw new Response("Not found", { status: 404 });
  return row;
}

// ---------- publish by instruction

export type AiPublishResult = { ok: true; version: string; changeId: string; emailed: boolean } | { ok: false; message: string };

/** The line the record, the email and the editor all use (decision 2c). */
export function publishedByLine(client: string): string {
  return `Published by ${client} on Dustin's instruction.`;
}

/**
 * Publishes the item as it stands on the site at `expectedVersion`: no text travels with it, so an
 * AI can only publish what a person saved. Every refusal comes before the site is asked anything.
 */
export async function aiPublish(
  env: Env,
  project: SiteProject,
  session: AiSession,
  itemId: string,
  expectedVersion: string,
  opts: { fetcher?: typeof fetch; carrelOrigin: string },
): Promise<AiPublishResult> {
  if (session.viewer.isReviewer) throw new AiRefusal("A reviewer never publishes.");
  // Owner only, whatever a shared person's role: decision 2a gives publish to Dustin's sessions alone.
  if (!session.viewer.isOwner || project.role !== "owner") throw new AiRefusal("Only the Owner's own sessions may publish.");
  const open = (await itemFindings(env.DB, project, itemId)).filter((f) => f.status === "open");
  if (open.length > 0) {
    throw new AiRefusal(
      `Publish is refused while ${open.length} flag${open.length === 1 ? " is" : "s are"} open on this post: ${open
        .map((f) => f.message)
        .join(" | ")} Dustin fixes the text or dismisses each flag in Carrel first.`,
    );
  }

  const outcome: WriteOutcome = await writeToSite(env, project, session.viewer, itemId, { action: "publish", expectedVersion }, opts.fetcher, {
    client: session.client,
  });
  if (!outcome.ok) return { ok: false, message: outcome.message };

  const d = drizzle(env.DB);
  await d.insert(aiPublications).values({
    changeId: outcome.changeId,
    projectId: project.id,
    itemId,
    personId: session.viewer.id,
    client: session.client,
    version: outcome.version,
  });

  // The email goes out now; if it cannot, the record keeps the error and the health check reports it.
  let emailed = false;
  try {
    const doc = await readDoc(env, project, itemId, opts.fetcher).catch(() => null);
    const title = doc?.title || itemId;
    const unpublish = `${opts.carrelOrigin}/p/${encodeURIComponent(project.slug)}/e/${encodeURIComponent(itemId)}/unpublish`;
    await env.EMAIL.send({
      from: env.ALERT_FROM,
      to: env.ALERT_EMAIL,
      subject: `Carrel: ${session.client} published "${title}"`,
      text: [
        publishedByLine(session.client),
        "",
        `${title} on ${siteEntry(project.site).name}${doc?.path ? `: ${doc.path}` : ""}`,
        `Version ${outcome.version}, change ${outcome.changeId}.`,
        "",
        `Unpublish it: ${unpublish}`,
        "",
      ].join("\n"),
    });
    emailed = true;
    await d.update(aiPublications).set({ emailedAt: new Date().toISOString() }).where(eq(aiPublications.changeId, outcome.changeId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ aiPublish: "email-failed", changeId: outcome.changeId, error: message }));
    await d.update(aiPublications).set({ emailError: message }).where(eq(aiPublications.changeId, outcome.changeId));
  }
  return { ok: true, version: outcome.version, changeId: outcome.changeId, emailed };
}

/** The last AI publish of an item, for the editor to show who published it. */
export async function lastAiPublication(db: D1Database, project: SiteProject, itemId: string) {
  return (
    (await drizzle(db)
      .select({ client: aiPublications.client, publishedAt: aiPublications.publishedAt, emailedAt: aiPublications.emailedAt })
      .from(aiPublications)
      .where(and(eq(aiPublications.projectId, project.id), eq(aiPublications.itemId, itemId)))
      .orderBy(desc(aiPublications.publishedAt))
      .get()) ?? null
  );
}

// ---------- social posts, drafted by the session that finished the piece (decision 5)

/**
 * Stores an AI session's drafted social post for the queue, by the event id the routine was given or
 * by account and item. Social posts are Dustin's alone, so only his own sessions may draft them.
 */
export async function aiDraftSocialPost(
  db: D1Database,
  session: AiSession,
  input: { eventId: number; text: string } | { accountKey: string; projectId: number; itemId: string; text: string },
): Promise<{ postId: number }> {
  if (session.viewer.isReviewer || !session.viewer.isOwner) throw new AiRefusal("Social posts are Dustin's: only his own sessions may draft them.");
  const result =
    "eventId" in input
      ? await draftForEvent(db, { eventId: input.eventId, text: input.text, createdBy: session.client })
      : await draftSocialPost(db, { ...input, createdBy: session.client });
  if (!result.ok) throw new AiRefusal(result.error);
  return { postId: result.postId };
}
