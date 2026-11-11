// What Carrel reports about itself to Capsid's inbox (POST /ops/inbox/report), for the app badge in
// the shared AdminShell: the AI drafts waiting for Dustin's review. Each report replaces the last
// whole and Capsid expires it after 6 hours, so the cron sends it every run (15 minutes), and sends
// no items when nothing waits so a cleared queue clears the badge. The bearer is Carrel's own Capsid
// agent key, the secret CAPSID_AGENT_KEY. Never on a page's path: a failure is logged, not thrown.

import { count, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts } from "~/db/schema";
import { carrelOrigin } from "~/lib/mcp/server";
import { timedFetch } from "@dustinedwards/site-runtime/http";
import {
  capsidOrigin,
  reportInbox,
  type InboxItem,
  type ReportResult,
} from "@dustinedwards/site-runtime/inbox-report";

import { errorMessage } from "@dustinedwards/site-runtime/log";
type InboxReport = { namespace: "carrel"; items: InboxItem[] };

/** The report body for `waiting` AI drafts, the oldest made at `since`. None waiting: no items. */
function inboxReport(waiting: number, since: string | null, origin: string): InboxReport {
  if (waiting <= 0) return { namespace: "carrel", items: [] };
  const item: InboxItem = {
    title: waiting === 1 ? "1 AI draft waits for review" : `${waiting} AI drafts wait for review`,
    link: `${origin}/`,
  };
  if (since) item.since = since;
  return { namespace: "carrel", items: [item] };
}

/** Counts the waiting AI drafts and reports them. Never throws; a failure is logged and returned. */
export async function reportDraftsInbox(
  env: Env,
  fetcher: typeof fetch = timedFetch,
): Promise<ReportResult> {
  try {
    const row = await drizzle(env.DB)
      .select({ waiting: count(), since: min(aiDrafts.createdAt) })
      .from(aiDrafts)
      .get();
    const body = inboxReport(row?.waiting ?? 0, row?.since ?? null, carrelOrigin(env));
    return await reportInbox({
      namespace: body.namespace,
      items: body.items,
      key: env.CAPSID_AGENT_KEY?.trim(),
      origin: capsidOrigin(env),
      fetcher,
    });
  } catch (error) {
    const detail = errorMessage(error);
    console.error(JSON.stringify({ inbox: "report-failed", error: detail }));
    return { state: "failed", detail };
  }
}
