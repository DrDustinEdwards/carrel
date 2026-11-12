// Keeping Cloudflare Access in step with Carrel's people (Dustin's ruling of 2026-10-10, point 2b:
// coauthor accounts scoped to one project). Carrel never holds a Cloudflare token: it posts its whole
// allow list to Capsid's POST /ops/access-sync with its own Capsid agent key (CAPSID_AGENT_KEY), and
// Capsid makes the Access group pinned for namespace "carrel" hold exactly those emails (capsid
// src/access-sync.ts). Each sync sends the whole list, so a missed one is mended by the next.
//
// The outcome is kept in one row (drizzle/0023_access_sync.sql) for the People page to show. A sync
// never throws to the page: a refusal or a network failure is recorded, and Retry sends it again.

import { and, eq, exists, isNull, not, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { accessSync, people, projectMembers } from "~/db/schema";
import { agentEmail } from "~/lib/agent-keys.server";
import { postAccessSync, type AccessSyncResult } from "@dustinedwards/site-runtime/access-sync";
import { capsidOrigin } from "@dustinedwards/site-runtime/inbox-report";
import { timedFetch } from "@dustinedwards/site-runtime/http";

import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
/**
 * Who Access should let into Desk: every active person with a role on at least one project. Left out
 * are AI agents (they reach the AI door with a key, never through Access), reviewers (another
 * company's agent, through the AI door only), and the Owner, whom the admin policy on Desk's Access
 * application lists directly, so no sync can add or remove the Owner.
 */
async function accessEmails(db: D1Database): Promise<string[]> {
  const d = drizzle(db);
  const rows = await d
    .select({ email: people.email })
    .from(people)
    .where(
      and(
        isNull(people.disabledAt),
        eq(people.isOwner, false),
        eq(people.isReviewer, false),
        not(like(people.email, `${agentEmail("")}%`)),
        exists(
          d
            .select({ one: projectMembers.personId })
            .from(projectMembers)
            .where(eq(projectMembers.personId, people.id)),
        ),
      ),
    )
    .all();
  return rows.map((r) => r.email.toLowerCase()).sort();
}

type AccessSyncRow = typeof accessSync.$inferSelect;

/** What the People page says about Access: not set up (no key), or the last sync's outcome (null before the first). */
export type AccessState = { configured: false } | { configured: true; last: AccessSyncRow | null };

export async function accessState(env: Env): Promise<AccessState> {
  if (!env.CAPSID_AGENT_KEY?.trim()) return { configured: false };
  const last = await drizzle(env.DB).select().from(accessSync).where(eq(accessSync.id, 1)).get();
  return { configured: true, last: last ?? null };
}

export type SyncOutcome = { state: "skipped" | "in-step" | "waiting"; detail: string };

/**
 * Posts the allow list. `removed` names people this change just took out (disabled, or left with no
 * role), so Capsid frees their Zero Trust seats; anyone still on the list is not sent as removed.
 */
export async function syncAccess(
  env: Env,
  change: { removed: string[] },
  fetcher: typeof fetch = timedFetch,
  now = new Date(),
): Promise<SyncOutcome> {
  const key = env.CAPSID_AGENT_KEY?.trim();
  if (!key)
    return {
      state: "skipped",
      detail: "CAPSID_AGENT_KEY is not set, so Access is managed by hand.",
    };
  let result: AccessSyncResult;
  try {
    result = await postAccessSync({
      key,
      namespace: "carrel",
      members: await accessEmails(env.DB),
      removed: change.removed,
      origin: capsidOrigin(env),
      fetch: fetcher,
    });
  } catch (error) {
    result = { ok: false, refusal: errorMessage(error) };
  }
  const ok = result.ok;
  const refusal = result.ok ? null : result.refusal.slice(0, 1000);
  const added = result.ok ? result.added : 0;
  const dropped = result.ok ? result.dropped : 0;
  const row = { syncedAt: now.toISOString(), ok, refusal, added, dropped };
  try {
    await drizzle(env.DB)
      .insert(accessSync)
      .values({ id: 1, ...row })
      .onConflictDoUpdate({ target: accessSync.id, set: row });
  } catch (error) {
    logEvent("access.sync-record-failed", { error: errorMessage(error) }, { level: "error" });
  }
  if (!ok) logEvent("access.sync-refused", { refusal }, { level: "error" });
  return ok
    ? { state: "in-step", detail: `${added} added, ${dropped} dropped.` }
    : { state: "waiting", detail: refusal ?? "" };
}
