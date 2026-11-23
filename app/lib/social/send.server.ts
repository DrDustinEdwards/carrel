// Posting what the queue holds: one account's queued posts, kept to its daily cap, the gap between posts and X's
// monthly budget, each claimed before it leaves so no post goes out twice.

import { errorMessage } from "@dustinedwards/site-runtime/log";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { isoDay } from "@drdustinedwards/site-helpers/xml";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { socialPosts } from "~/db/schema";

import { credentialsFor, postOriginal, xCostMills } from "./platforms.server";
import type { Account, Fetch, TickResult } from "./queue.server";

export function dayStart(now: Date): string {
  return `${isoDay(now)}T00:00:00.000Z`;
}

function monthStart(now: Date): string {
  return `${monthKey(now)}-01T00:00:00.000Z`;
}

export async function sendQueued(
  env: Env,
  account: Account,
  now: Date,
  fetcher: Fetch,
  result: TickResult,
) {
  const d = drizzle(env.DB);
  const queued = await d
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.accountId, account.id), eq(socialPosts.status, "queued")))
    .orderBy(asc(socialPosts.id))
    .all();
  if (queued.length === 0) return;
  const sent = await d
    .select({ sentAt: socialPosts.sentAt, cost: socialPosts.costMills })
    .from(socialPosts)
    .where(
      and(
        eq(socialPosts.accountId, account.id),
        eq(socialPosts.status, "sent"),
        gte(socialPosts.sentAt, monthStart(now)),
      ),
    )
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
      await d
        .update(socialPosts)
        .set({
          error: `Held: it would pass this month's X budget (${formatMoney(account.monthlyBudgetMills, "usd", { scale: 3 })}).`,
        })
        .where(eq(socialPosts.id, post.id));
      result.waitingOnCaps++;
      return;
    }
    if ("missing" in creds) {
      await d
        .update(socialPosts)
        .set({ error: `Waiting for credentials: ${creds.missing.join(", ")}.` })
        .where(eq(socialPosts.id, post.id));
      result.errors.push(`${account.key}: credentials missing`);
      return;
    }
    // Claim it before it leaves: an overlapping run, or a Reject made since the read, finds no row.
    const claim = await env.DB.prepare(
      "UPDATE social_posts SET sent_at = ? WHERE id = ? AND status = 'queued' AND sent_at IS NULL",
    )
      .bind(now.toISOString(), post.id)
      .run();
    if (!claim.meta.changes) continue;
    try {
      const id = await postOriginal(creds, post.text, fetcher, now.getTime());
      await d
        .update(socialPosts)
        .set({
          status: "sent",
          platformPostId: id,
          costMills: cost,
          sentAt: now.toISOString(),
          error: null,
        })
        .where(eq(socialPosts.id, post.id));
      today++;
      spent += cost;
      last = now.getTime();
      result.sent++;
    } catch (error) {
      const message = errorMessage(error);
      await d
        .update(socialPosts)
        .set({ status: "failed", error: message, sentAt: null })
        .where(eq(socialPosts.id, post.id));
      result.errors.push(`${account.key}: ${message}`);
    }
  }
}
