// Posting one account's queued posts within its caps, each claimed first so none goes out twice.

import { errorMessage } from "@dustinedwards/site-runtime/log";
import { formatMoney } from "@dustinedwards/site-runtime/money";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { isoDay } from "@drdustinedwards/site-helpers/xml";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { socialPosts } from "~/db/schema";

import { credentialsFor, postOriginal, xCostMills } from "./platforms.server";
import { updatePost, type Account, type Fetch, type TickResult } from "./queue.server";

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
      await updatePost(env.DB, post.id, {
        error: `Held: it would pass this month's X budget (${formatMoney(account.monthlyBudgetMills, "usd", { scale: 3 })}).`,
      });
      result.waitingOnCaps++;
      return;
    }
    if ("missing" in creds) {
      await updatePost(env.DB, post.id, {
        error: `Waiting for credentials: ${creds.missing.join(", ")}.`,
      });
      result.errors.push(`${account.key}: credentials missing`);
      return;
    }
    // Claim it before it leaves: an overlapping run, or a Reject made since the read, finds no row.
    const claim = await d
      .update(socialPosts)
      .set({ sentAt: now.toISOString() })
      .where(
        and(
          eq(socialPosts.id, post.id),
          eq(socialPosts.status, "queued"),
          isNull(socialPosts.sentAt),
        ),
      )
      .run();
    if (!claim.meta.changes) continue;
    try {
      const id = await postOriginal(creds, post.text, fetcher, now.getTime());
      await updatePost(env.DB, post.id, {
        status: "sent",
        platformPostId: id,
        costMills: cost,
        sentAt: now.toISOString(),
        error: null,
      });
      today++;
      spent += cost;
      last = now.getTime();
      result.sent++;
    } catch (error) {
      const message = errorMessage(error);
      await updatePost(env.DB, post.id, { status: "failed", error: message, sentAt: null });
      result.errors.push(`${account.key}: ${message}`);
    }
  }
}
