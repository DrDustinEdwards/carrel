// Carrel's own health check, run by the cron trigger. It emails Dustin only when a check changes
// state, like the site's watchdog, so a standing failure sends one message, not one every 15 minutes.
//
// Stage 1 checks what stage 1 has: the settings the gate needs, the database and its Owner, and the
// Access signing keys. Later stages add the Google key, site keys and the site APIs.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { healthState, people } from "~/db/schema";
import { teamIssuer } from "~/lib/access.server";

export type CheckResult = { name: string; ok: boolean; detail: string };

type Fetch = (input: string) => Promise<Response>;

const PLACEHOLDER = /example\.(com|cloudflareaccess\.com)/i;

async function checkConfig(env: Env): Promise<CheckResult> {
  const missing: string[] = [];
  if (!env.ACCESS_AUD?.trim()) missing.push("ACCESS_AUD");
  if (!env.ACCESS_TEAM_DOMAIN?.trim() || PLACEHOLDER.test(env.ACCESS_TEAM_DOMAIN)) missing.push("ACCESS_TEAM_DOMAIN");
  if (!env.ALERT_EMAIL?.trim() || PLACEHOLDER.test(env.ALERT_EMAIL)) missing.push("ALERT_EMAIL");
  return missing.length === 0
    ? { name: "config", ok: true, detail: "Access and alert settings are present." }
    : { name: "config", ok: false, detail: `Missing or placeholder: ${missing.join(", ")}.` };
}

async function checkOwner(env: Env): Promise<CheckResult> {
  try {
    const owners = await drizzle(env.DB).select({ id: people.id }).from(people).where(eq(people.isOwner, true)).all();
    return owners.length === 1
      ? { name: "owner", ok: true, detail: "The database answers and has its Owner." }
      : { name: "owner", ok: false, detail: "The database has no Owner, so nobody can use Carrel. Run npm run seed:owner." };
  } catch (error) {
    return { name: "owner", ok: false, detail: `The database did not answer: ${message(error)}` };
  }
}

async function checkAccessKeys(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const url = `${teamIssuer(env.ACCESS_TEAM_DOMAIN ?? "")}/cdn-cgi/access/certs`;
  try {
    const response = await fetcher(url);
    if (!response.ok) return { name: "access-keys", ok: false, detail: `${url} answered ${response.status}.` };
    const body = (await response.json()) as { keys?: unknown[] };
    return Array.isArray(body.keys) && body.keys.length > 0
      ? { name: "access-keys", ok: true, detail: "Access signing keys are published." }
      : { name: "access-keys", ok: false, detail: `${url} lists no signing keys.` };
  } catch (error) {
    return { name: "access-keys", ok: false, detail: `${url} could not be read: ${message(error)}` };
  }
}

export async function runChecks(env: Env, fetcher: Fetch = (url) => fetch(url)): Promise<CheckResult[]> {
  return Promise.all([checkConfig(env), checkOwner(env), checkAccessKeys(env, fetcher)]);
}

/**
 * Runs the checks, emails when any check changed state, and only then records the new states. If
 * the email fails, nothing is recorded, so the next run tries again rather than losing the alert.
 * A check seen for the first time counts as a change only when it fails.
 */
export async function runHealth(
  env: Env,
  fetcher?: Fetch,
  now: () => Date = () => new Date(),
): Promise<{ results: CheckResult[]; emailed: boolean }> {
  const results = await runChecks(env, fetcher);
  const db = drizzle(env.DB);

  let previous: Map<string, boolean>;
  try {
    const rows = await db.select().from(healthState).all();
    previous = new Map(rows.map((r) => [r.checkName, r.ok]));
  } catch {
    previous = new Map();
  }

  const changed = results.filter((r) => {
    const before = previous.get(r.name);
    return before === undefined ? !r.ok : before !== r.ok;
  });
  const unseen = results.filter((r) => !previous.has(r.name));
  if (changed.length === 0 && unseen.length === 0) return { results, emailed: false };

  let emailed = false;
  if (changed.length > 0) {
    const failing = results.filter((r) => !r.ok);
    try {
      await env.EMAIL.send({
        from: env.ALERT_FROM,
        to: env.ALERT_EMAIL,
        subject: failing.length === 0 ? "Carrel: all checks pass" : `Carrel: ${failing.length} check${failing.length === 1 ? "" : "s"} failing`,
        text: results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`).join("\n"),
      });
      emailed = true;
    } catch (error) {
      console.error(JSON.stringify({ health: "email-failed", error: message(error) }));
      return { results, emailed: false };
    }
  }

  const at = now().toISOString();
  try {
    for (const r of [...new Set([...changed, ...unseen])]) {
      await db
        .insert(healthState)
        .values({ checkName: r.name, ok: r.ok, detail: r.detail, changedAt: at })
        .onConflictDoUpdate({ target: healthState.checkName, set: { ok: r.ok, detail: r.detail, changedAt: at } });
    }
  } catch (error) {
    console.error(JSON.stringify({ health: "record-failed", error: message(error) }));
  }
  return { results, emailed };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
