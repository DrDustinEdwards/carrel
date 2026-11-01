// Carrel's own health check, run by the cron trigger. It emails Dustin only when a check changes
// state, like the site's watchdog, so a standing failure sends one message, not one every 15 minutes.
//
// It checks the settings the gate needs, the database and its Owner, the Access signing keys, and
// each site: its key, and whether the site still conforms to the site-api contract Carrel was built
// against, the GitHub App for the writing repository, that every AI publish reached Dustin's inbox,
// Google (the service account key's age and whether Google still takes it, and Dustin's drive.file
// grant), and any template social post that went out, which Dustin should know about (design
// decision 5, third step).
//
// Each run also rewrites the public conformance report (conformanceReport below), which devkit's
// shared scoreboard reads; it carries check names and the site's API address, never a key or site text.

import { backupHealth } from "@dustinedwards/d1-dump";
import { PACKAGE_VERSION } from "@dustinedwards/site-api";
import { runConformance } from "@dustinedwards/site-api/conformance";
import { accessIssuer } from "@dustinedwards/site-runtime/access";
import { cronCheck } from "@dustinedwards/site-runtime/cron";
import { auditLogCheck } from "@dustinedwards/site-runtime/audit-log";
import { durableObjectCheck, healthResponse, kvCheck } from "@dustinedwards/site-runtime/health";
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiPublications, googleKeysSeen, googleTokens, healthState, people, reports } from "~/db/schema";
import { ALL_JOBS } from "~/lib/cron-schedule";
import { deployedSha } from "~/lib/deployed";
import { oauthConnection, userAccessToken } from "~/lib/google/oauth.server";
import { saAccessToken, saConnection } from "~/lib/google/service-account.server";
import { installationToken, NOVELS_REPO, novelsConnection } from "~/lib/novels/repo.server";
import { SITE_IDS, siteConnection, siteEntry, type SiteId } from "~/lib/sites.server";
import { unseenTemplates } from "~/lib/social/queue.server";
import { timedFetch } from "~/lib/timed-fetch.server";

/** A site's line in the conformance report, in the scoreboard's format (devkit live/README). */
type SiteConformance = {
  status: "pass" | "fail" | "error";
  findings: { severity: "error"; check: "M1"; detail: string }[];
};

export type CheckResult = { name: string; ok: boolean; detail: string; conformance?: { origin: string } & SiteConformance };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

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
  const url = `${accessIssuer(env.ACCESS_TEAM_DOMAIN) ?? ""}/cdn-cgi/access/certs`;
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

/**
 * A site with no key is not connected yet, which is not a failure: its stage has not arrived. With a
 * key, the conformance suite runs, including its writes, each of which a conforming site refuses. On
 * a site that offers media (site-api v0.2.0) that includes the media checks: limits declared, list in
 * shape, a delete of an unknown id and an upload of an undeclared type both refused. On a site that
 * declares the mentions group (v0.5.0) it includes the mentions checks: the list in shape, writes without
 * the key refused, a decision and a delete of an unknown id refused, a stale version refused on the first
 * real mention, and a sweep with no change id refused; a site without the group must answer 501. The suite's real
 * upload round trip stays off: the health check never puts a file into a site's storage.
 */
async function checkSite(env: Env, id: SiteId, fetcher: Fetch): Promise<CheckResult> {
  const name = `site-${id}`;
  const site = siteEntry(id).name;
  const connection = siteConnection(env, id);
  if (connection.state === "not-connected") return { name, ok: true, detail: `Not connected: ${connection.detail}` };
  if (connection.state === "misconfigured") return { name, ok: false, detail: connection.detail };
  const api = `${connection.origin}/api/carrel/v1`;
  const error = (detail: string): CheckResult["conformance"] => ({
    origin: connection.origin,
    status: "error",
    findings: [{ severity: "error", check: "M1", detail: `${api} ${detail}` }],
  });
  try {
    const report = await runConformance({
      baseUrl: connection.origin,
      key: connection.key,
      probeMediaUpload: false,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        fetcher(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch,
    });
    if (report.ok) {
      return { name, ok: true, detail: `${site} conforms (${report.checks[0]?.detail ?? "meta ok"}).`, conformance: { origin: connection.origin, status: "pass", findings: [] } };
    }
    const failed = report.checks.filter((c) => !c.ok);
    return {
      name,
      ok: false,
      detail: `${site} does not conform. ${failed.map((c) => `${c.name}: ${c.detail}`).join(" | ")}`,
      // The check's name only: its detail can quote the site's answer, which stays in Dustin's email.
      conformance: { origin: connection.origin, status: "fail", findings: failed.map((c) => ({ severity: "error", check: "M1", detail: `${api} ${c.name} failed` })) },
    };
  } catch (thrown) {
    return { name, ok: false, detail: `${site} could not be checked: ${message(thrown)}`, conformance: error("could not be checked") };
  }
}

/** The newest complete D1 dump must be under 26 hours old (d1-dump's default). No complete dump at all fails too. */
async function checkBackup(env: Env, now: Date): Promise<CheckResult> {
  try {
    const { last_ok, age_hours, warning } = await backupHealth(env.BACKUPS, { now });
    if (last_ok === null || warning) return { name: "backup", ok: false, detail: warning ?? "No complete D1 dump exists yet." };
    return { name: "backup", ok: true, detail: `The newest complete D1 dump finished ${last_ok}, ${age_hours} hours ago.` };
  } catch (error) {
    return { name: "backup", ok: false, detail: `The backup bucket could not be read: ${message(error)}` };
  }
}

/** Not set up yet is not a failure, as with a site; set up, the App must still get a token for the repository. */
async function checkNovels(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const connection = novelsConnection(env);
  if (connection.state !== "connected") {
    return connection.state === "not-connected"
      ? { name: "writing", ok: true, detail: `Not connected: ${connection.detail}` }
      : { name: "writing", ok: false, detail: connection.detail };
  }
  try {
    await installationToken(connection.appId, connection.privateKey, ((input: RequestInfo | URL, init?: RequestInit) =>
      fetcher(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch);
    return { name: "writing", ok: true, detail: `The GitHub App can write to ${NOVELS_REPO}.` };
  } catch (error) {
    return { name: "writing", ok: false, detail: `The GitHub App could not reach ${NOVELS_REPO}: ${message(error)}` };
  }
}

/** Decision 2c: every AI publish emails Dustin. One whose email failed stays a failure until it is sent. */
async function checkAiPublishEmails(env: Env): Promise<CheckResult> {
  try {
    const unsent = await drizzle(env.DB)
      .select({ changeId: aiPublications.changeId, itemId: aiPublications.itemId, client: aiPublications.client, error: aiPublications.emailError })
      .from(aiPublications)
      .where(isNull(aiPublications.emailedAt))
      .all();
    if (unsent.length === 0) return { name: "ai-publish-email", ok: true, detail: "Every AI publish was emailed." };
    return {
      name: "ai-publish-email",
      ok: false,
      detail: `${unsent.length} AI publish${unsent.length === 1 ? " was" : "es were"} not emailed: ${unsent
        .map((u) => `${u.itemId} by ${u.client} (${u.error ?? "no error recorded"})`)
        .join("; ")}.`,
    };
  } catch (error) {
    return { name: "ai-publish-email", ok: false, detail: `The record could not be read: ${message(error)}` };
  }
}

/** Google recommends rotating service account keys at least every 90 days. */
const KEY_MAX_AGE_DAYS = 90;

/**
 * The service account key: absent is "not connected" (its stage's setup is Dustin's), a key Google
 * refuses (deleted, disabled, expired) fails, and so does one older than KEY_MAX_AGE_DAYS. A key file
 * carries no creation date, so age counts from the first time this check saw the key.
 */
async function checkServiceAccount(env: Env, fetcher: Fetch, now: Date): Promise<CheckResult> {
  const connection = saConnection(env);
  if (connection.state === "not-connected") return { name: "google-service-account", ok: true, detail: `Not connected: ${connection.detail}` };
  if (connection.state === "misconfigured") return { name: "google-service-account", ok: false, detail: connection.detail };
  const { key } = connection;
  const d = drizzle(env.DB);
  await d.insert(googleKeysSeen).values({ privateKeyId: key.privateKeyId, clientEmail: key.clientEmail, firstSeenAt: now.toISOString() }).onConflictDoNothing();
  const seen = await d.select({ firstSeenAt: googleKeysSeen.firstSeenAt }).from(googleKeysSeen).where(eq(googleKeysSeen.privateKeyId, key.privateKeyId)).get();
  const days = Math.floor((now.getTime() - Date.parse(seen!.firstSeenAt)) / 86_400_000);
  const id = key.privateKeyId.slice(0, 8);
  try {
    await saAccessToken(key, ((input: RequestInfo | URL, init?: RequestInit) =>
      fetcher(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch);
  } catch (error) {
    return { name: "google-service-account", ok: false, detail: `Key ${id} (${key.clientEmail}) no longer works: ${message(error)} Create a new key and set GOOGLE_SA_KEY.` };
  }
  if (days > KEY_MAX_AGE_DAYS) {
    return { name: "google-service-account", ok: false, detail: `Key ${id} is ${days} days old, past ${KEY_MAX_AGE_DAYS}. Create a new key, set GOOGLE_SA_KEY, then delete the old one in Google Cloud.` };
  }
  return { name: "google-service-account", ok: true, detail: `Key ${id} (${key.clientEmail}) works; ${days} days old.` };
}

/** Dustin's drive.file grant, if he has connected it: Google must still refresh it. */
async function checkDriveFile(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const connection = await oauthConnection(env);
  if (connection.state === "not-configured") return { name: "google-drive-file", ok: true, detail: `Not connected: ${connection.detail}` };
  if (connection.state === "misconfigured") return { name: "google-drive-file", ok: false, detail: connection.detail };
  const grants = await drizzle(env.DB).select({ personId: googleTokens.personId }).from(googleTokens).all();
  if (grants.length === 0) return { name: "google-drive-file", ok: true, detail: "Not connected: no one has connected Google for Send to Docs yet." };
  try {
    for (const g of grants) {
      await userAccessToken(env, g.personId, ((input: RequestInfo | URL, init?: RequestInit) =>
        fetcher(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch);
    }
    return { name: "google-drive-file", ok: true, detail: "The drive.file grant refreshes." };
  } catch (error) {
    return { name: "google-drive-file", ok: false, detail: message(error) };
  }
}

/** A template post went out: the routine failed or hit its cap. Fails until Dustin marks it seen. */
async function checkSocialTemplates(env: Env): Promise<CheckResult> {
  try {
    const unseen = await unseenTemplates(env.DB);
    if (unseen.length === 0) return { name: "social-templates", ok: true, detail: "No template post is waiting to be seen." };
    return {
      name: "social-templates",
      ok: false,
      detail: `${unseen.length} template post${unseen.length === 1 ? "" : "s"} went out because the routine did not draft ${unseen.length === 1 ? "it" : "them"}: ${unseen
        .map((u) => `${u.accountKey}: "${u.text}"`)
        .join("; ")}. Mark ${unseen.length === 1 ? "it" : "them"} seen in Carrel's social page.`,
    };
  } catch (error) {
    return { name: "social-templates", ok: false, detail: `The social record could not be read: ${message(error)}` };
  }
}

export async function runChecks(
  env: Env,
  fetcher: Fetch = (url, init) => timedFetch(url, init),
  now: Date = new Date(),
): Promise<CheckResult[]> {
  return Promise.all([
    checkConfig(env),
    checkOwner(env),
    checkAccessKeys(env, fetcher),
    ...SITE_IDS.map((id) => checkSite(env, id, fetcher)),
    checkNovels(env, fetcher),
    checkAiPublishEmails(env),
    checkBackup(env, now),
    checkServiceAccount(env, fetcher, now),
    checkDriveFile(env, fetcher),
    checkSocialTemplates(env),
  ]);
}

/**
 * The scoreboard's report: every connected site's conformance, keyed by its origin. A site not
 * connected yet is left out, so the scoreboard, not this report, decides whether that is expected.
 */
function conformanceReport(results: CheckResult[], at: string) {
  const sites: Record<string, SiteConformance> = {};
  for (const r of results) if (r.conformance) sites[r.conformance.origin] = { status: r.conformance.status, findings: r.conformance.findings };
  return { check: "carrel-conformance", at, ref: `site-api v${PACKAGE_VERSION}`, sites };
}

/**
 * Runs the checks, rewrites the conformance report, emails when any check changed state, and only then records the new states. If
 * the email fails, nothing is recorded, so the next run tries again rather than losing the alert.
 * A check seen for the first time counts as a change only when it fails.
 */
export async function runHealth(
  env: Env,
  fetcher?: Fetch,
  now: () => Date = () => new Date(),
): Promise<{ results: CheckResult[]; emailed: boolean }> {
  const results = await runChecks(env, fetcher, now());
  const db = drizzle(env.DB);
  try {
    const at = now().toISOString();
    const body = JSON.stringify(conformanceReport(results, at));
    await db.insert(reports).values({ name: "conformance", body, at }).onConflictDoUpdate({ target: reports.name, set: { body, at } });
  } catch (error) {
    console.error(JSON.stringify({ health: "report-failed", error: message(error) }));
  }

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

/**
 * GET /health, the one answer on both hosts (site-runtime's healthResponse). On the AI door it is outside Access, so it
 * says only what any family site says in public: D1 answers, the bindings are there, the dump's age, the crons, the
 * deployed commit the live gate waits for, and the names (never the details) of the checks above that are failing.
 *
 * Levels (H3). Only D1 (`db`, the helper's ping) is fail level: without it neither door can find a person, so Carrel is
 * down and a 503 is the truth. Everything else is warn and answers 200:
 * - oauth-kv is warn, a stated choice. Without OAUTH_KV the AI door cannot issue or check a grant, but Desk, the app
 *   people use, still serves every page and save, so a 503 would call Carrel down while it works. The warn still reaches
 *   Capsid's watcher, which reads the checks.
 * - doc-room and mcp-rate-limit are Durable Object namespaces (site-runtime's
 *   durableObjectCheck: bound, and an id minted; no object is woken or billed). Without DOC_ROOM co-editing stops but
 *   the editor still saves; without the rate limiter the AI door refuses calls, as with OAUTH_KV.
 * - tool-call-log is site-runtime's auditLogCheck (L8): a call with no finished row after 15 minutes, a spike, or rows
 *   not copied to AUDIT_BUCKET for two days. Without TOOL_CALL_LOG it fails too, and the AI door refuses calls.
 * - email is the send_email binding, checked present only: sending a probe would mail Dustin every few minutes. A failed
 *   send is already seen where it matters, as the ai-publish-email check above and the health run's own alert.
 * Left out: CSP_REPORT_RATE_LIMIT, because a probe would spend a count and a missing binding only drops reports, which
 * the receiver answers 204 regardless. BACKUPS is the backup check's own read.
 */
export function healthAnswer(env: Env): Promise<Response> {
  return healthResponse({
    ping: () => env.DB.prepare("SELECT 1").first(),
    backup: () => backupHealth(env.BACKUPS),
    sha: deployedSha(env),
    checks: [
      { ...kvCheck("oauth-kv", env.OAUTH_KV), level: "warn" },
      durableObjectCheck("doc-room", env.DOC_ROOM),
      durableObjectCheck("mcp-rate-limit", env.MCP_RATE_LIMIT),
      // The tool-call log (L8, warn with an alert): a call with no finished row, a spike, or rows not copied for two days.
      auditLogCheck(env),
      { name: "email", level: "warn", run: async () => typeof env.EMAIL?.send === "function" || { ok: false, detail: "The EMAIL binding is missing." } },
      // Each job with its own interval, so one that never ran (a trigger that does not fire it) warns too. Held back
      // until its window has passed since this version was deployed.
      cronCheck(env.DB, { jobs: ALL_JOBS, deployedAt: deployedAt(env) }),
      {
        name: "alerts",
        level: "warn",
        run: async () => {
          const failing = await drizzle(env.DB).select({ name: healthState.checkName }).from(healthState).where(eq(healthState.ok, false)).all();
          return failing.length === 0 || { ok: false, detail: `Failing: ${failing.map((f) => f.name).join(", ")}.` };
        },
      },
    ],
  });
}

/** When this version was deployed, from the CF_VERSION_METADATA binding; read loosely, since an older config has none. */
function deployedAt(env: Env): Date | undefined {
  const timestamp = (env as { CF_VERSION_METADATA?: { timestamp?: string } }).CF_VERSION_METADATA?.timestamp;
  const at = timestamp ? new Date(timestamp) : undefined;
  return at && !Number.isNaN(at.getTime()) ? at : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
