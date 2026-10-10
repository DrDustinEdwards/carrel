// What Carrel reports about itself to Capsid's inbox (POST /ops/inbox/report), for the app badge in
// the shared AdminShell: the AI drafts waiting for Dustin's review. Each report replaces the last
// whole and Capsid expires it after 6 hours, so the cron sends it every run (15 minutes), and sends
// no items when nothing waits so a cleared queue clears the badge. The bearer is Carrel's own Capsid
// agent key, the secret CAPSID_AGENT_KEY. Never on a page's path: a failure is logged, not thrown.

import { count, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts } from "~/db/schema";
import { carrelOrigin } from "~/lib/mcp/server";

export const CAPSID_REPORT_URL = "https://mcp.dustinedwards.info/ops/inbox/report";

export type InboxItem = { title: string; link?: string; since?: string };
export type InboxReport = { namespace: "carrel"; items: InboxItem[] };

/** The report body for `waiting` AI drafts, the oldest made at `since`. None waiting: no items. */
export function inboxReport(waiting: number, since: string | null, origin: string): InboxReport {
  if (waiting <= 0) return { namespace: "carrel", items: [] };
  const item: InboxItem = {
    title: waiting === 1 ? "1 AI draft waits for review" : `${waiting} AI drafts wait for review`,
    link: `${origin}/`,
  };
  if (since) item.since = since;
  return { namespace: "carrel", items: [item] };
}

export type ReportResult = { state: "skipped" | "sent" | "failed"; detail: string };

/** Counts the waiting AI drafts and reports them. Never throws; a failure is logged and returned. */
export async function reportInbox(env: Env, fetcher: typeof fetch = fetch): Promise<ReportResult> {
  const key = env.CAPSID_AGENT_KEY?.trim();
  if (!key) return { state: "skipped", detail: "CAPSID_AGENT_KEY is not set." };
  try {
    const row = await drizzle(env.DB)
      .select({ waiting: count(), since: min(aiDrafts.createdAt) })
      .from(aiDrafts)
      .get();
    const body = inboxReport(row?.waiting ?? 0, row?.since ?? null, carrelOrigin(env));
    const response = await fetcher(CAPSID_REPORT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Capsid answered ${response.status}`);
    return { state: "sent", detail: `${body.items.length} item(s) reported.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ inbox: "report-failed", error: detail }));
    return { state: "failed", detail };
  }
}
