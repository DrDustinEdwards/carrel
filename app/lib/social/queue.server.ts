// The social queue (design decision 5). A piece going live is the only thing a post can announce.
// For each account that announces that project, the post comes from, in order:
//
//   1. a draft stored ahead by the session that finished the piece (draftSocialPost);
//   2. else a Claude Code routine Carrel fires, batching every waiting item into one run (the
//      routine stores its drafts the same way), with a nightly sweep;
//   3. else, when the routine fails or its daily cap is reached, or it drafted nothing in time, a
//      template post, which the health check reports to Dustin.
//
// Every post is linted; a finding holds it for Dustin. Then each account's switch decides: approval
// (Dustin approves each post) or auto (it goes when the caps allow). Nothing here calls an AI. The
// loop over accounts, the daily cap, the gap between posts and the record of every post are carried
// over from legacy Recova's social-poster cron.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { socialAccounts, socialEvents, socialPosts, socialRoutineRuns } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";

import { lintPost } from "./lint";
import { credentialsFor, postOriginal, xCostMills } from "./platforms.server";
import { fireRoutine, routineConfig, routinePrompt } from "./routine.server";

type Fetch = typeof fetch;

/** How long published items gather before one routine run takes them all. */
export const BATCH_DELAY_MS = 30 * 60_000;
/** How long the routine has to store its drafts before the template is used. */
export const ROUTINE_WAIT_MS = 3 * 60 * 60_000;
/** Routine runs a day: one to three, under the subscription's routine cap (design decision 5). */
export const ROUTINE_DAILY_CAP = 3;
/** The nightly sweep's hour, UTC (3 a.m. Central in daylight time). */
export const NIGHTLY_HOUR_UTC = 8;

const DEFAULT_TEMPLATE = "New: {title}. {summary} {link}";

function requireOwner(viewer: Viewer) {
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
}

function dayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function monthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

// ---------- accounts and switches

export type AccountInput = { key: string; name: string; platform: "bluesky" | "x"; kind: "personal" | "brand"; handle: string; projectId: number | null };

export async function createAccount(db: D1Database, viewer: Viewer, input: AccountInput) {
  requireOwner(viewer);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.key)) return { ok: false as const, error: "The key is lower-case letters, digits and hyphens, such as germomics-bluesky." };
  if (!input.name.trim() || !input.handle.trim()) return { ok: false as const, error: "Give the account a name and its handle." };
  try {
    // Every account starts off, in approval mode.
    await drizzle(db).insert(socialAccounts).values({ ...input, name: input.name.trim(), handle: input.handle.trim().replace(/^@/, ""), enabled: false, mode: "approval" });
  } catch {
    return { ok: false as const, error: `An account with the key ${input.key} already exists.` };
  }
  return { ok: true as const };
}

export async function setSwitches(db: D1Database, viewer: Viewer, id: number, input: { enabled?: boolean; mode?: "approval" | "auto"; dailyCap?: number; monthlyBudgetMills?: number; template?: string; voiceGuide?: string }) {
  requireOwner(viewer);
  const d = drizzle(db);
  const account = await d.select().from(socialAccounts).where(eq(socialAccounts.id, id)).get();
  if (!account) throw new Response("Not found", { status: 404 });
  // The personal account is approved post by post, always.
  if (input.mode === "auto" && account.kind === "personal") return { ok: false as const, error: "The personal account is always approval: every post is Dustin's call." };
  const set: Partial<typeof socialAccounts.$inferInsert> = {};
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.mode) set.mode = input.mode;
  if (input.dailyCap !== undefined) set.dailyCap = Math.max(0, Math.min(20, Math.floor(input.dailyCap)));
  if (input.monthlyBudgetMills !== undefined) set.monthlyBudgetMills = Math.max(0, Math.floor(input.monthlyBudgetMills));
  if (input.template !== undefined) set.template = input.template.slice(0, 500);
  if (input.voiceGuide !== undefined) set.voiceGuide = input.voiceGuide.slice(0, 4000);
  if (Object.keys(set).length) await d.update(socialAccounts).set(set).where(eq(socialAccounts.id, id));
  return { ok: true as const };
}

// ---------- events and drafts

/** The description line in a post's frontmatter: Dustin's one-line summary, for templates and the routine. */
export function summaryFrom(source: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source.replace(/\r\n/g, "\n"))?.[1] ?? "";
  return /^description:\s*"?(.*?)"?\s*$/m.exec(fm)?.[1]?.trim() ?? "";
}

/**
 * A piece went live: every account announcing its project gets an event, which becomes sendable now.
 * An account that is off when the piece goes live closes its event, so turning it on later does
 * not post a backlog.
 */
export async function recordPublication(db: D1Database, projectId: number, item: { id: string; title: string; url: string; summary: string }, now = new Date()) {
  const d = drizzle(db);
  const accounts = await d.select().from(socialAccounts).where(eq(socialAccounts.projectId, projectId)).all();
  for (const account of accounts) {
    const values = { title: item.title, url: item.url, summary: item.summary, publishedAt: now.toISOString() };
    const existing = await d
      .select()
      .from(socialEvents)
      .where(and(eq(socialEvents.accountId, account.id), eq(socialEvents.projectId, projectId), eq(socialEvents.itemId, item.id)))
      .get();
    if (existing?.publishedAt) continue; // Announced once, not on every re-publish.
    const state = account.enabled ? (existing?.state ?? "waiting") : "closed";
    if (existing) await d.update(socialEvents).set({ ...values, state }).where(eq(socialEvents.id, existing.id));
    else await d.insert(socialEvents).values({ accountId: account.id, projectId, itemId: item.id, ...values, state });
  }
}

/**
 * Stores a drafted post for an account and a piece, ahead of publication or after the routine was
 * asked for it. The newest draft replaces any earlier one that has not gone out. This is what the
 * session that finishes a piece, and the routine, call through MCP.
 */
export async function draftSocialPost(db: D1Database, input: { accountKey: string; projectId: number; itemId: string; text: string; createdBy: string }) {
  const d = drizzle(db);
  const account = await d.select().from(socialAccounts).where(eq(socialAccounts.key, input.accountKey)).get();
  if (!account || account.projectId !== input.projectId) return { ok: false as const, error: `No account ${input.accountKey} announces this project.` };
  let event = await d
    .select()
    .from(socialEvents)
    .where(and(eq(socialEvents.accountId, account.id), eq(socialEvents.projectId, input.projectId), eq(socialEvents.itemId, input.itemId)))
    .get();
  if (!event) {
    [event] = await d.insert(socialEvents).values({ accountId: account.id, projectId: input.projectId, itemId: input.itemId }).returning();
  }
  if (event!.state === "templated" || event!.state === "closed") return { ok: false as const, error: "This item's post was already settled (template used, or the account was off)." };
  await d
    .update(socialPosts)
    .set({ status: "rejected", error: "Replaced by a newer draft." })
    .where(and(eq(socialPosts.eventId, event!.id), inArray(socialPosts.status, ["drafted", "held", "awaiting", "queued"])));
  const [post] = await d
    .insert(socialPosts)
    .values({ accountId: account.id, eventId: event!.id, text: input.text.trim(), source: event!.state === "routine" ? "routine" : "predrafted", status: "drafted", createdBy: input.createdBy })
    .returning({ id: socialPosts.id });
  return { ok: true as const, postId: post!.id };
}

/** The routine is told each item by its event id; this stores its draft for that event. */
export async function draftForEvent(db: D1Database, input: { eventId: number; text: string; createdBy: string }) {
  const row = await drizzle(db)
    .select({ event: socialEvents, key: socialAccounts.key })
    .from(socialEvents)
    .innerJoin(socialAccounts, eq(socialAccounts.id, socialEvents.accountId))
    .where(eq(socialEvents.id, input.eventId))
    .get();
  if (!row) return { ok: false as const, error: `No social event ${input.eventId}.` };
  return draftSocialPost(db, { accountKey: row.key, projectId: row.event.projectId, itemId: row.event.itemId, text: input.text, createdBy: input.createdBy });
}

function fillTemplate(template: string, event: { title: string; summary: string; url: string }): string {
  return (template || DEFAULT_TEMPLATE)
    .replaceAll("{title}", event.title)
    .replaceAll("{summary}", event.summary)
    .replaceAll("{link}", event.url)
    .replace(/\s+/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .replace(/\.\./g, ".")
    .trim();
}

// ---------- the tick

export type TickResult = { linted: number; routineFired: number; templated: number; sent: number; waitingOnCaps: number; errors: string[] };

type Account = typeof socialAccounts.$inferSelect;

/** Lints a drafted post and routes it by the account's switch. */
async function route(db: D1Database, post: typeof socialPosts.$inferSelect, account: Account) {
  const findings = lintPost(post.text, account.platform);
  const status = findings.length ? "held" : account.mode === "auto" ? "queued" : "awaiting";
  await drizzle(db).update(socialPosts).set({ status, lint: JSON.stringify(findings) }).where(eq(socialPosts.id, post.id));
  await drizzle(db).update(socialEvents).set({ state: "covered" }).where(and(eq(socialEvents.id, post.eventId), inArray(socialEvents.state, ["waiting", "routine"])));
}

async function useTemplate(db: D1Database, event: typeof socialEvents.$inferSelect, account: Account) {
  const d = drizzle(db);
  const [post] = await d
    .insert(socialPosts)
    .values({ accountId: account.id, eventId: event.id, text: fillTemplate(account.template, event), source: "template", status: "drafted", createdBy: "template" })
    .returning();
  await d.update(socialEvents).set({ state: "templated" }).where(eq(socialEvents.id, event.id));
  await route(db, post!, account);
}

async function sendQueued(env: Env, account: Account, now: Date, fetcher: Fetch, result: TickResult) {
  const d = drizzle(env.DB);
  const queued = await d.select().from(socialPosts).where(and(eq(socialPosts.accountId, account.id), eq(socialPosts.status, "queued"))).orderBy(asc(socialPosts.id)).all();
  if (queued.length === 0) return;
  const sent = await d
    .select({ sentAt: socialPosts.sentAt, cost: socialPosts.costMills })
    .from(socialPosts)
    .where(and(eq(socialPosts.accountId, account.id), eq(socialPosts.status, "sent"), gte(socialPosts.sentAt, monthStart(now))))
    .orderBy(desc(socialPosts.sentAt))
    .all();
  let today = sent.filter((s) => s.sentAt! >= dayStart(now)).length;
  let spent = sent.reduce((n, s) => n + s.cost, 0);
  let last = sent[0]?.sentAt ? Date.parse(sent[0].sentAt) : 0;
  const creds = credentialsFor(env, account);

  for (const post of queued) {
    // Recova's caps, per account: the daily cap and the gap between posts; X's monthly budget too.
    if (today >= account.dailyCap || now.getTime() - last < account.minGapMinutes * 60_000) {
      result.waitingOnCaps++;
      return;
    }
    const cost = account.platform === "x" ? xCostMills(post.text) : 0;
    if (account.platform === "x" && spent + cost > account.monthlyBudgetMills) {
      await d.update(socialPosts).set({ error: `Held: it would pass this month's X budget ($${(account.monthlyBudgetMills / 1000).toFixed(2)}).` }).where(eq(socialPosts.id, post.id));
      result.waitingOnCaps++;
      return;
    }
    if ("missing" in creds) {
      await d.update(socialPosts).set({ error: `Waiting for credentials: ${creds.missing.join(", ")}.` }).where(eq(socialPosts.id, post.id));
      result.errors.push(`${account.key}: credentials missing`);
      return;
    }
    try {
      const id = await postOriginal(creds, post.text, fetcher, now.getTime());
      await d.update(socialPosts).set({ status: "sent", platformPostId: id, costMills: cost, sentAt: now.toISOString(), error: null }).where(eq(socialPosts.id, post.id));
      today++;
      spent += cost;
      last = now.getTime();
      result.sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await d.update(socialPosts).set({ status: "failed", error: message }).where(eq(socialPosts.id, post.id));
      result.errors.push(`${account.key}: ${message}`);
    }
  }
}

/** One pass of the queue, run by the cron. Every step is idempotent, so a missed run loses nothing. */
export async function processSocial(env: Env, deps: { fetcher?: Fetch; now?: Date } = {}): Promise<TickResult> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? new Date();
  const d = drizzle(env.DB);
  const result: TickResult = { linted: 0, routineFired: 0, templated: 0, sent: 0, waitingOnCaps: 0, errors: [] };
  const accounts = new Map((await d.select().from(socialAccounts).where(eq(socialAccounts.enabled, true)).all()).map((a) => [a.id, a]));
  if (accounts.size === 0) return result;
  const ids = [...accounts.keys()];

  // 1. Drafts for published pieces, stored ahead or by the routine: lint, then the switch.
  const drafted = await d
    .select({ post: socialPosts })
    .from(socialPosts)
    .innerJoin(socialEvents, eq(socialEvents.id, socialPosts.eventId))
    .where(and(eq(socialPosts.status, "drafted"), isNotNull(socialEvents.publishedAt), inArray(socialPosts.accountId, ids)))
    .all();
  for (const { post } of drafted) {
    await route(env.DB, post, accounts.get(post.accountId)!);
    result.linted++;
  }

  // 3a. The routine was asked and drafted nothing in time: the template.
  const stale = await d
    .select({ event: socialEvents, requestedAt: socialRoutineRuns.requestedAt })
    .from(socialEvents)
    .innerJoin(socialRoutineRuns, eq(socialRoutineRuns.id, socialEvents.routineRunId))
    .where(and(eq(socialEvents.state, "routine"), inArray(socialEvents.accountId, ids), lte(socialRoutineRuns.requestedAt, new Date(now.getTime() - ROUTINE_WAIT_MS).toISOString())))
    .all();
  for (const { event } of stale) {
    await useTemplate(env.DB, event, accounts.get(event.accountId)!);
    result.templated++;
  }

  // 2. Published pieces with no draft: one routine run for all of them, after the batch delay, or
  // at the nightly sweep.
  const nightly = now.getUTCHours() === NIGHTLY_HOUR_UTC;
  const waiting = (
    await d
      .select()
      .from(socialEvents)
      .where(and(eq(socialEvents.state, "waiting"), isNotNull(socialEvents.publishedAt), inArray(socialEvents.accountId, ids)))
      .all()
  ).filter((e) => nightly || Date.parse(e.publishedAt!) <= now.getTime() - BATCH_DELAY_MS);
  if (waiting.length > 0) {
    const config = routineConfig(env);
    const runsToday = await d.select({ id: socialRoutineRuns.id }).from(socialRoutineRuns).where(and(eq(socialRoutineRuns.status, "fired"), gte(socialRoutineRuns.requestedAt, dayStart(now)))).all();
    let templateAll: string | null = null;
    if ("missing" in config) templateAll = config.missing;
    else if (runsToday.length >= ROUTINE_DAILY_CAP) templateAll = `the routine's daily cap of ${ROUTINE_DAILY_CAP} runs is reached`;
    else {
      const prompt = routinePrompt(
        waiting.map((e) => {
          const a = accounts.get(e.accountId)!;
          return { eventId: e.id, account: `${a.name} (${a.key})`, platform: a.platform, voiceGuide: a.voiceGuide, title: e.title, url: e.url, summary: e.summary };
        }),
      );
      const fired = await fireRoutine(config, prompt, fetcher);
      const [run] = await d
        .insert(socialRoutineRuns)
        .values({
          kind: nightly ? "nightly" : "batch",
          requestedAt: now.toISOString(),
          events: JSON.stringify(waiting.map((e) => e.id)),
          status: fired.ok ? "fired" : "failed",
          sessionUrl: fired.ok ? fired.sessionUrl : null,
          error: fired.ok ? null : fired.error,
        })
        .returning({ id: socialRoutineRuns.id });
      if (fired.ok) {
        await d.update(socialEvents).set({ state: "routine", routineRunId: run!.id }).where(inArray(socialEvents.id, waiting.map((e) => e.id)));
        result.routineFired++;
      } else if (!fired.retry) {
        templateAll = `the routine refused the run (${fired.error})`;
      } else {
        // The hourly limit or a brief outage: the next tick tries again; the items keep waiting.
        result.errors.push(`routine: ${fired.error}`);
      }
    }
    if (templateAll) {
      result.errors.push(`template used: ${templateAll}`);
      for (const event of waiting) {
        await useTemplate(env.DB, event, accounts.get(event.accountId)!);
        result.templated++;
      }
    }
  }

  // Posts cleared to go: within each account's caps.
  for (const account of accounts.values()) await sendQueued(env, account, now, fetcher, result);
  return result;
}

// ---------- Dustin's decisions

export async function decidePost(
  db: D1Database,
  viewer: Viewer,
  id: number,
  decision: { action: "approve" | "reject" | "by-hand" | "acknowledge" } | { action: "edit"; text: string },
  now = new Date(),
) {
  requireOwner(viewer);
  const d = drizzle(db);
  const row = await d.select({ post: socialPosts, account: socialAccounts }).from(socialPosts).innerJoin(socialAccounts, eq(socialAccounts.id, socialPosts.accountId)).where(eq(socialPosts.id, id)).get();
  if (!row) throw new Response("Not found", { status: 404 });
  const { post, account } = row;
  const open = ["held", "awaiting"].includes(post.status);
  switch (decision.action) {
    case "approve":
      // A held post is approved only once its text passes the lint (edit it first).
      if (post.status !== "awaiting") return { ok: false as const, error: post.status === "held" ? "Edit the post until the lint passes, then approve it." : "Only a post awaiting approval can be approved." };
      await d.update(socialPosts).set({ status: "queued", approvedBy: viewer.id }).where(eq(socialPosts.id, id));
      return { ok: true as const };
    case "reject":
      if (!open && post.status !== "queued") return { ok: false as const, error: "Only a post that has not gone out can be rejected." };
      await d.update(socialPosts).set({ status: "rejected", approvedBy: viewer.id }).where(eq(socialPosts.id, id));
      return { ok: true as const };
    case "by-hand":
      // The personal account's free path: Dustin copies the text and posts it himself.
      if (!open) return { ok: false as const, error: "Only a post that has not gone out can be posted by hand." };
      await d.update(socialPosts).set({ status: "by-hand", approvedBy: viewer.id, sentAt: now.toISOString() }).where(eq(socialPosts.id, id));
      return { ok: true as const };
    case "edit": {
      if (!open) return { ok: false as const, error: "Only a held or awaiting post can be edited." };
      const findings = lintPost(decision.text, account.platform);
      await d.update(socialPosts).set({ text: decision.text.trim(), lint: JSON.stringify(findings), status: findings.length ? "held" : "awaiting" }).where(eq(socialPosts.id, id));
      return { ok: true as const, findings };
    }
    case "acknowledge":
      if (post.source !== "template") return { ok: false as const, error: "Only a template post has an alert to acknowledge." };
      await d.update(socialPosts).set({ acknowledgedAt: now.toISOString() }).where(eq(socialPosts.id, id));
      return { ok: true as const };
  }
}

// ---------- reading

export async function socialOverview(db: D1Database, viewer: Viewer) {
  requireOwner(viewer);
  const d = drizzle(db);
  const [accounts, posts, runs] = await Promise.all([
    d.select().from(socialAccounts).orderBy(asc(socialAccounts.key)).all(),
    d
      .select({ post: socialPosts, title: socialEvents.title, url: socialEvents.url, accountKey: socialAccounts.key, platform: socialAccounts.platform, kind: socialAccounts.kind })
      .from(socialPosts)
      .innerJoin(socialEvents, eq(socialEvents.id, socialPosts.eventId))
      .innerJoin(socialAccounts, eq(socialAccounts.id, socialPosts.accountId))
      .orderBy(desc(socialPosts.id))
      .limit(100)
      .all(),
    d.select().from(socialRoutineRuns).orderBy(desc(socialRoutineRuns.id)).limit(10).all(),
  ]);
  return { accounts, posts, runs };
}

/** Template posts that went out and Dustin has not yet marked seen: the health check's alert. */
export async function unseenTemplates(db: D1Database) {
  return drizzle(db)
    .select({ id: socialPosts.id, accountKey: socialAccounts.key, text: socialPosts.text })
    .from(socialPosts)
    .innerJoin(socialAccounts, eq(socialAccounts.id, socialPosts.accountId))
    .where(and(eq(socialPosts.source, "template"), eq(socialPosts.status, "sent"), isNull(socialPosts.acknowledgedAt)))
    .all();
}
