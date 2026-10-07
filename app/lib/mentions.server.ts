// Webmentions on a site project (site-api v0.5.0, the mentions group): the queue of what other sites
// sent, and the Owner's decisions on it. Mentions are text strangers chose, so they are shown as text
// and decided here, one site write each, in order. One failing never stops the rest, and every outcome
// is said in plain words.
//
// Roles, checked here so the page, the JSON endpoint and any later tool meet the same rule:
// carrel/design.md says the inbox belongs to Dustin alone, so reading the queue (read_mentions) and
// deciding (decide_mention) are both the Owner's. Change roles.ts, not this file, to open it wider.
//
// Authorship: every write the site carried out writes one row in mention_decisions (migration 0011),
// with the change id Carrel sent the site so the two histories join. A refused write writes nothing.
// The write and the site's cache purge are one unit on the site's side; Carrel reports its answer.

import { MentionId, Version, type MentionItem, type MentionList, type MentionStatus } from "@dustinedwards/site-api";
import { SiteApiError } from "@dustinedwards/site-api/client";
import { drizzle } from "drizzle-orm/d1";

import { mentionDecisions } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can, type Action } from "~/lib/roles";
import { siteClient, SiteNotConnected } from "~/lib/sites.server";

export const MAX_MENTION_BATCH = 100;
export const MENTIONS_PER_PAGE = 50;

/** The views of the queue, pending first because it is the one that wants an action. */
export const MENTION_FILTERS = ["pending", "failed", "approved", "rejected", "unverified", "all"] as const;
export type MentionFilter = (typeof MENTION_FILTERS)[number];

export function isMentionFilter(value: string | null | undefined): value is MentionFilter {
  return (MENTION_FILTERS as readonly string[]).includes(value ?? "");
}

export type MentionOp = "approve" | "reject" | "delete";

/** One mention to act on: its id, the version the person saw, and the status they saw it in. */
export type MentionTarget = { id: string; version: string; status: MentionStatus };

/** One mention's outcome. `ok` false means this mention was left as it was; the message says why. */
export type MentionResult = { id: string; ok: boolean; message: string };

export type SweepResult = { ok: true; message: string; removed: { failed: number; rejected: number }; recorded: boolean } | { ok: false; message: string };

/** Who did it: the person, and the AI client when it came through the AI door (credited in the record). */
export type MentionActor = { viewer: Viewer; client?: string };

function requireCan(project: { role: SiteProject["role"] }, action: Action) {
  if (!can(project.role, action)) throw new Response("Forbidden", { status: 403 });
}

/**
 * Whether the site moderates mentions through Carrel, from its meta. A site on an older site API, or
 * one whose adapter has no mentions, says no and the reason is plain; a site that does not answer says that.
 */
export async function mentionsOffered(
  env: Env,
  project: SiteProject,
  fetcher?: typeof fetch,
): Promise<{ offered: true } | { offered: false; reason: string }> {
  requireCan(project, "read_mentions");
  try {
    const meta = await siteClient(env, project.site, fetcher).meta();
    return meta.capabilities.mentions === true ? { offered: true } : { offered: false, reason: "This site does not receive webmentions through Carrel yet." };
  } catch (error) {
    if (error instanceof SiteNotConnected) return { offered: false, reason: error.detail };
    console.error(JSON.stringify({ meta: "failed", error: String(error) }));
    return { offered: false, reason: "The site did not answer, so Carrel cannot tell whether it receives webmentions." };
  }
}

/**
 * One page of the queue. With no filter the queue opens on Pending, and on All when nothing is
 * pending, as the site's own page does. The counts and the number a sweep would remove cover the whole queue.
 */
export async function listMentions(
  env: Env,
  project: SiteProject,
  query: { filter?: MentionFilter | null; cursor?: string },
  fetcher?: typeof fetch,
): Promise<{ filter: MentionFilter; list: MentionList }> {
  requireCan(project, "read_mentions");
  const client = siteClient(env, project.site, fetcher);
  const page = (filter: MentionFilter) =>
    client.mentions.list({
      limit: MENTIONS_PER_PAGE,
      ...(filter === "all" ? {} : { status: filter }),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  if (query.filter) return { filter: query.filter, list: await page(query.filter) };
  const pending = await page("pending");
  if (pending.items.length > 0 || pending.counts.pending > 0) return { filter: "pending", list: pending };
  return { filter: "all", list: await page("all") };
}

const MESSAGES: Record<MentionOp, { done: string }> = {
  approve: { done: "Approved." },
  reject: { done: "Rejected." },
  delete: { done: "Deleted." },
};

const STALE = "This mention changed on the site since the page loaded. It was left as it was; reload to see it.";

/** What went wrong for one mention, said plainly. Anything unexpected is logged and reported, never dropped. */
function failure(id: string, error: unknown): MentionResult {
  if (error instanceof SiteNotConnected) return { id, ok: false, message: error.detail };
  if (error instanceof SiteApiError) {
    if (error.status === 501) return { id, ok: false, message: "The site does not moderate mentions through Carrel yet." };
    if (error.body?.error === "version-conflict") return { id, ok: false, message: STALE };
    if (error.status === 404) return { id, ok: false, message: "The site no longer has this mention. It may have been deleted or swept." };
    if (error.body?.error === "refused") return { id, ok: false, message: error.body.message };
    console.error(JSON.stringify({ mentions: "item-failed", id, status: error.status, code: error.body?.error ?? null }));
    return { id, ok: false, message: "The site did not accept this change. The mention was left as it was." };
  }
  console.error(JSON.stringify({ mentions: "item-failed", id, error: String(error) }));
  return { id, ok: false, message: "Something went wrong with this mention. It was left as it was." };
}

/** Said when the write moved but the site could not clear its cache: the post's page keeps the old mentions for a while. */
const PURGE_FAILED = " The site could not clear its cache, so the post's page may show the old mentions until its cache expires.";

/** The ids and versions to act on: unique, each shaped as a site could hold it. Anything else is reported, not sent. */
export function parseTargets(raw: unknown): { targets: MentionTarget[]; invalid: string[] } {
  const targets: MentionTarget[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { targets, invalid };
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const status = ["unverified", "pending", "approved", "rejected", "failed"].find((s) => s === e.status) as MentionStatus | undefined;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!MentionId.safeParse(id).success || !Version.safeParse(e.version).success || !status) invalid.push(id || "(no id)");
    else targets.push({ id, version: e.version as string, status });
  }
  return { targets, invalid };
}

async function record(
  env: Env,
  project: SiteProject,
  actor: MentionActor,
  row: { mentionId: string | null; action: "approve" | "reject" | "delete" | "sweep"; statusBefore: MentionStatus | null; statusAfter: MentionStatus | null; changeId: string },
): Promise<boolean> {
  try {
    await drizzle(env.DB).insert(mentionDecisions).values({
      projectId: project.id,
      personId: actor.viewer.id,
      client: actor.client ?? null,
      ...row,
    });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ record: "failed", action: row.action, mentionId: row.mentionId, changeId: row.changeId, error: String(error) }));
    return false;
  }
}

/**
 * Approves, rejects or deletes each mention, in order, each with its own change id and its own
 * authorship row. The role is checked once before the site is asked anything. Each write carries the
 * version the person saw, so a mention the site changed since (re-sent, decided elsewhere) is refused
 * as stale and stays.
 */
export async function decideMentions(
  env: Env,
  project: SiteProject,
  actor: MentionActor,
  op: MentionOp,
  rawTargets: unknown,
  fetcher?: typeof fetch,
): Promise<MentionResult[]> {
  requireCan(project, "decide_mention");
  const { targets, invalid } = parseTargets(rawTargets);
  if (targets.length + invalid.length === 0) throw new Response("Choose at least one mention.", { status: 400 });
  if (targets.length + invalid.length > MAX_MENTION_BATCH) throw new Response(`At most ${MAX_MENTION_BATCH} mentions at a time.`, { status: 400 });

  const results: MentionResult[] = invalid.map((id) => ({ id, ok: false, message: "That is not a mention Carrel can send to the site, so it was not sent." }));
  const client = siteClient(env, project.site, fetcher);
  for (const target of targets) {
    const changeId = crypto.randomUUID();
    try {
      let statusAfter: MentionStatus | null = null;
      let purged: boolean | null;
      if (op === "delete") {
        ({ purged } = await client.mentions.delete(target.id, { expectedVersion: target.version, changeId }));
      } else {
        const written = await client.mentions.decide(target.id, { decision: op, expectedVersion: target.version, changeId });
        statusAfter = written.status;
        purged = written.purged;
      }
      const recorded = await record(env, project, actor, { mentionId: target.id, action: op, statusBefore: target.status, statusAfter, changeId });
      results.push({
        id: target.id,
        ok: true,
        message: MESSAGES[op].done + (purged === false ? PURGE_FAILED : "") + (recorded ? "" : " Carrel could not save the record of it; tell the Owner."),
      });
    } catch (error) {
      results.push(failure(target.id, error));
    }
  }
  return results;
}

/** Removes the failed and rejected mentions past the site's retention windows. Owner only; the site decides what is expired. */
export async function sweepMentions(env: Env, project: SiteProject, actor: MentionActor, fetcher?: typeof fetch): Promise<SweepResult> {
  requireCan(project, "decide_mention");
  const changeId = crypto.randomUUID();
  try {
    const { removed } = await siteClient(env, project.site, fetcher).mentions.sweep(changeId);
    const recorded = await record(env, project, actor, { mentionId: null, action: "sweep", statusBefore: null, statusAfter: null, changeId });
    return {
      ok: true,
      removed,
      recorded,
      message:
        `Removed ${removed.failed} failed and ${removed.rejected} rejected mention${removed.failed + removed.rejected === 1 ? "" : "s"} past their retention window.` +
        (recorded ? "" : " Carrel could not save the record of it; tell the Owner."),
    };
  } catch (error) {
    const { message } = failure("sweep", error);
    return { ok: false, message };
  }
}

export type { MentionItem, MentionList };
