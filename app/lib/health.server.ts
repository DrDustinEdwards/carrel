// Carrel's own health check, run by the cron trigger. It emails Dustin only when a check changes state, so a standing
// failure sends one message, not one every 15 minutes.
//
// It checks the settings the gate needs, the database and its Owner, the Access signing keys, each site (its key, and
// whether it still conforms to the site-api contract), the GitHub App for the writing repository, that every AI publish
// reached Dustin's inbox, Google (the service account key's age, the Search Console properties and Dustin's drive.file
// grant), and any template social post that went out.
//
// Each run also rewrites the public conformance report, which devkit's shared scoreboard reads; it carries check names and
// the site's API address, never a key or site text.

import { sendEmail } from "@dustinedwards/site-runtime/email";
import { PACKAGE_VERSION } from "@dustinedwards/site-api";
import { runConformance } from "@dustinedwards/site-api/conformance";
import { accessIssuer } from "@dustinedwards/site-runtime/access";
import { auditLogCheck } from "@dustinedwards/site-runtime/audit-log";
import {
  aiOutcomeCheck,
  durableObjectCheck,
  emailCheck,
  kvCheck,
  r2Check,
  siteHealthResponse,
} from "@dustinedwards/site-runtime/health";
import { and, eq, isNotNull, isNull, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { changes, googleKeysSeen, googleTokens, healthState, people, reports } from "~/db/schema";
import { backupStatus } from "~/lib/backup.server";
import { ALL_JOBS } from "~/lib/cron-schedule";
import { oauthConnection, userAccessToken } from "~/lib/google/oauth.server";
import { searchConsoleAccess } from "~/lib/google/search-console.server";
import {
  GoogleNotConnected,
  saAccessToken,
  saConnection,
} from "~/lib/google/service-account.server";
import { installationToken, NOVELS_REPO, novelsConnection } from "~/lib/novels/repo.server";
import { SITE_IDS, siteConnection, siteEntry, type SiteId } from "~/lib/sites.server";
import { unseenTemplates } from "~/lib/social/queue.server";
import { timedFetch } from "@dustinedwards/site-runtime/http";
import { plural } from "@drdustinedwards/site-helpers/text";

import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
/** A site's line in the conformance report, in the scoreboard's format (devkit live/README). */
type SiteConformance = {
  status: "pass" | "fail" | "error";
  findings: { severity: "error"; check: "M1"; detail: string }[];
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
  conformance?: { origin: string } & SiteConformance;
};

/**
 * The probe post publishes, renames and deletes a post, and each purges the site's stored pages. Cloudflare rations purges
 * per account, shared by every site's Worker (Free: 5 a minute, bucket of 25), so each health run (every 15 minutes)
 * probes only the one site that is due: once a day, and an hour after a failing probe. A site's failures are kept
 * (reports, "probe-sites") and carried into every report until its next probe.
 */
const PROBE_REPORT = "probe-sites";
const PROBE_EVERY_MS = 24 * 60 * 60 * 1000;
const PROBE_RETRY_MS = 60 * 60 * 1000;
const PROBE_STEP = "probe post:";
type ProbeRecord = { sites: Record<string, { at: string; findings: SiteConformance["findings"] }> };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The string-address fetcher the checks take, as the platform's fetch. */
const asFetch =
  (fetcher: Fetch): typeof fetch =>
  (input, init) =>
    fetcher(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    );

const PLACEHOLDER = /example\.(com|cloudflareaccess\.com)/i;

async function checkConfig(env: Env): Promise<CheckResult> {
  const missing: string[] = [];
  if (!env.ACCESS_AUD?.trim()) missing.push("ACCESS_AUD");
  if (!env.ACCESS_TEAM_DOMAIN?.trim() || PLACEHOLDER.test(env.ACCESS_TEAM_DOMAIN))
    missing.push("ACCESS_TEAM_DOMAIN");
  if (!env.ALERT_EMAIL?.trim() || PLACEHOLDER.test(env.ALERT_EMAIL)) missing.push("ALERT_EMAIL");
  return missing.length === 0
    ? { name: "config", ok: true, detail: "Access and alert settings are present." }
    : { name: "config", ok: false, detail: `Missing or placeholder: ${missing.join(", ")}.` };
}

async function checkOwner(env: Env): Promise<CheckResult> {
  try {
    const owners = await drizzle(env.DB)
      .select({ id: people.id })
      .from(people)
      .where(eq(people.isOwner, true))
      .all();
    return owners.length === 1
      ? { name: "owner", ok: true, detail: "The database answers and has its Owner." }
      : {
          name: "owner",
          ok: false,
          detail: "The database has no Owner, so nobody can use Carrel. Run npm run seed:owner.",
        };
  } catch (error) {
    return {
      name: "owner",
      ok: false,
      detail: `The database did not answer: ${errorMessage(error)}`,
    };
  }
}

async function checkAccessKeys(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const url = `${accessIssuer(env.ACCESS_TEAM_DOMAIN) ?? ""}/cdn-cgi/access/certs`;
  try {
    const response = await fetcher(url);
    if (!response.ok)
      return { name: "access-keys", ok: false, detail: `${url} answered ${response.status}.` };
    const body = (await response.json()) as { keys?: unknown[] };
    return Array.isArray(body.keys) && body.keys.length > 0
      ? { name: "access-keys", ok: true, detail: "Access signing keys are published." }
      : { name: "access-keys", ok: false, detail: `${url} lists no signing keys.` };
  } catch (error) {
    return {
      name: "access-keys",
      ok: false,
      detail: `${url} could not be read: ${errorMessage(error)}`,
    };
  }
}

/**
 * A site with no key is not connected yet, which is not a failure. With a key, the conformance suite runs, including its
 * writes, each of which a conforming site refuses; a site that offers media or declares the mentions group also gets those
 * checks (a site without the mentions group must answer 501). The real upload round trip stays off: the health check never
 * puts a file into a site's storage.
 */
async function checkSite(
  env: Env,
  id: SiteId,
  fetcher: Fetch,
  probeDue: boolean,
): Promise<CheckResult> {
  const name = `site-${id}`;
  const site = siteEntry(id).name;
  const connection = siteConnection(env, id);
  if (connection.state === "not-connected")
    return { name, ok: true, detail: `Not connected: ${connection.detail}` };
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
      // The probe post: its 301, 410 and trash checks run live, once a day. A site that cannot delete content skips it.
      probePosts: probeDue,
      // The site's own starting source, as New post sends it: a site may require a slug or a date.
      newSource: (itemId) =>
        siteEntry(id).newSource?.(itemId, new Date().toISOString().slice(0, 10)) ?? "",
      imageAsUrl: siteEntry(id).imageAsUrl,
      author: siteEntry(id).author,
      fetch: asFetch(fetcher),
    });
    if (report.ok) {
      return {
        name,
        ok: true,
        detail: `${site} conforms (${report.checks[0]?.detail ?? "meta ok"}).`,
        conformance: { origin: connection.origin, status: "pass", findings: [] },
      };
    }
    const failed = report.checks.filter((c) => !c.ok);
    return {
      name,
      ok: false,
      detail: `${site} does not conform. ${failed.map((c) => `${c.name}: ${c.detail}`).join(" | ")}`,
      // The check's name only: its detail can quote the site's answer, which stays in Dustin's email. A probe post's
      // step is the exception: its detail is the status and error code the site answered, never its body.
      conformance: {
        origin: connection.origin,
        status: "fail",
        findings: failed.map((c) => ({
          severity: "error",
          check: "M1",
          detail: `${api} ${c.name} failed${c.name.startsWith(PROBE_STEP) ? `: ${c.detail.slice(0, 160)}` : ""}`,
        })),
      },
    };
  } catch (thrown) {
    return {
      name,
      ok: false,
      detail: `${site} could not be checked: ${errorMessage(thrown)}`,
      conformance: error("could not be checked"),
    };
  }
}

/** The newest complete D1 dump must be under 26 hours old (d1-dump's default). No complete dump at all fails too. */
async function checkBackup(env: Env, now: Date): Promise<CheckResult> {
  try {
    const { last_ok, age_hours, warning } = await backupStatus(env, now);
    if (last_ok === null || warning)
      return { name: "backup", ok: false, detail: warning ?? "No complete D1 dump exists yet." };
    return {
      name: "backup",
      ok: true,
      detail: `The newest complete D1 dump finished ${last_ok}, ${age_hours} hours ago.`,
    };
  } catch (error) {
    return {
      name: "backup",
      ok: false,
      detail: `The backup bucket could not be read: ${errorMessage(error)}`,
    };
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
    await installationToken(connection.appId, connection.privateKey, asFetch(fetcher));
    return { name: "writing", ok: true, detail: `The GitHub App can write to ${NOVELS_REPO}.` };
  } catch (error) {
    return {
      name: "writing",
      ok: false,
      detail: `The GitHub App could not reach ${NOVELS_REPO}: ${errorMessage(error)}`,
    };
  }
}

/** Decision 2c: every AI publish emails Dustin. One whose email failed stays a failure until it is sent. */
async function checkAiPublishEmails(env: Env): Promise<CheckResult> {
  try {
    const unsent = await drizzle(env.DB)
      .select({
        changeId: changes.id,
        itemId: changes.itemId,
        client: changes.client,
        error: changes.emailError,
      })
      .from(changes)
      .where(and(isNull(changes.emailedAt), isNotNull(changes.emailError)))
      .all();
    if (unsent.length === 0)
      return { name: "ai-publish-email", ok: true, detail: "Every AI publish was emailed." };
    return {
      name: "ai-publish-email",
      ok: false,
      detail: `${unsent.length} AI publish${unsent.length === 1 ? " was" : "es were"} not emailed: ${unsent
        .map((u) => `${u.itemId} by ${u.client} (${u.error ?? "no error recorded"})`)
        .join("; ")}.`,
    };
  } catch (error) {
    return {
      name: "ai-publish-email",
      ok: false,
      detail: `The record could not be read: ${errorMessage(error)}`,
    };
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
  if (connection.state === "not-connected")
    return {
      name: "google-service-account",
      ok: true,
      detail: `Not connected: ${connection.detail}`,
    };
  if (connection.state === "misconfigured")
    return { name: "google-service-account", ok: false, detail: connection.detail };
  const { key } = connection;
  const d = drizzle(env.DB);
  await d
    .insert(googleKeysSeen)
    .values({
      privateKeyId: key.privateKeyId,
      clientEmail: key.clientEmail,
      firstSeenAt: now.toISOString(),
    })
    .onConflictDoNothing();
  const seen = await d
    .select({ firstSeenAt: googleKeysSeen.firstSeenAt })
    .from(googleKeysSeen)
    .where(eq(googleKeysSeen.privateKeyId, key.privateKeyId))
    .get();
  const days = Math.floor((now.getTime() - Date.parse(seen!.firstSeenAt)) / 86_400_000);
  const id = key.privateKeyId.slice(0, 8);
  try {
    await saAccessToken(key, asFetch(fetcher));
  } catch (error) {
    return {
      name: "google-service-account",
      ok: false,
      detail: `Key ${id} (${key.clientEmail}) no longer works: ${errorMessage(error)} Create a new key and set GOOGLE_SA_KEY.`,
    };
  }
  if (days > KEY_MAX_AGE_DAYS) {
    return {
      name: "google-service-account",
      ok: false,
      detail: `Key ${id} is ${days} days old, past ${KEY_MAX_AGE_DAYS}. Create a new key, set GOOGLE_SA_KEY, then delete the old one in Google Cloud.`,
    };
  }
  return {
    name: "google-service-account",
    ok: true,
    detail: `Key ${id} (${key.clientEmail}) works; ${days} days old.`,
  };
}

/**
 * Each connected site's Search Console property must be shared with the service account, a setup step that is
 * Dustin's. One that is not fails here, so it is emailed once when it starts and once when it is fixed, while the
 * refresh skips it in silence rather than logging the same refusal every quarter hour.
 */
async function checkSearchConsole(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const name = "google-search-console";
  try {
    const { email, sites } = await searchConsoleAccess(env, fetcher as typeof fetch);
    const unshared = sites.filter((s) => !s.shared).map((s) => s.property);
    // The step is Search Console Help's "Managing owners, users, and permissions" (support.google.com/webmasters/answer/7687615).
    return unshared.length === 0
      ? { name, ok: true, detail: `${sites.length} shared.` }
      : {
          name,
          ok: false,
          detail: `Not shared with ${email}: ${unshared.join(", ")}. In Search Console: Settings, Users and permissions, Full.`,
        };
  } catch (error) {
    // Not connected is the service account's own setup, which google-service-account reports.
    return { name, ok: error instanceof GoogleNotConnected, detail: errorMessage(error) };
  }
}

/** Dustin's drive.file grant, if he has connected it: Google must still refresh it. */
async function checkDriveFile(env: Env, fetcher: Fetch): Promise<CheckResult> {
  const connection = await oauthConnection(env);
  if (connection.state === "not-configured")
    return { name: "google-drive-file", ok: true, detail: `Not connected: ${connection.detail}` };
  if (connection.state === "misconfigured")
    return { name: "google-drive-file", ok: false, detail: connection.detail };
  const grants = await drizzle(env.DB)
    .select({ personId: googleTokens.personId })
    .from(googleTokens)
    .all();
  if (grants.length === 0)
    return {
      name: "google-drive-file",
      ok: true,
      detail: "Not connected: no one has connected Google for Send to Docs yet.",
    };
  try {
    for (const g of grants) {
      await userAccessToken(env, g.personId, asFetch(fetcher));
    }
    return { name: "google-drive-file", ok: true, detail: "The drive.file grant refreshes." };
  } catch (error) {
    return { name: "google-drive-file", ok: false, detail: errorMessage(error) };
  }
}

/** A template post went out: the routine failed or hit its cap. Fails until Dustin marks it seen. */
async function checkSocialTemplates(env: Env): Promise<CheckResult> {
  try {
    const unseen = await unseenTemplates(env.DB);
    if (unseen.length === 0)
      return {
        name: "social-templates",
        ok: true,
        detail: "No template post is waiting to be seen.",
      };
    return {
      name: "social-templates",
      ok: false,
      detail: `${plural(unseen.length, "template post")} went out because the routine did not draft ${unseen.length === 1 ? "it" : "them"}: ${unseen
        .map((u) => `${u.accountKey}: "${u.text}"`)
        .join("; ")}. Mark ${unseen.length === 1 ? "it" : "them"} seen in Carrel's social page.`,
    };
  } catch (error) {
    return {
      name: "social-templates",
      ok: false,
      detail: `The social record could not be read: ${errorMessage(error)}`,
    };
  }
}

export async function runChecks(
  env: Env,
  fetcher: Fetch = (url, init) => timedFetch(url, init),
  now: Date = new Date(),
): Promise<CheckResult[]> {
  const last = await lastProbe(env);
  const probed = nextProbe(env, last, now);
  const results = await Promise.all([
    checkConfig(env),
    checkOwner(env),
    checkAccessKeys(env, fetcher),
    ...SITE_IDS.map((id) => checkSite(env, id, fetcher, id === probed?.id)),
    checkNovels(env, fetcher),
    checkAiPublishEmails(env),
    checkBackup(env, now),
    checkServiceAccount(env, fetcher, now),
    checkSearchConsole(env, fetcher),
    checkDriveFile(env, fetcher),
    checkSocialTemplates(env),
  ]);
  return settleProbe(env, results, last, probed?.origin, now);
}

/** The connected site whose probe is due and oldest (never probed first), or undefined. */
export function nextProbe(env: Env, last: ProbeRecord | null, now: Date) {
  let next: { id: SiteId; origin: string; at: number } | undefined;
  for (const id of SITE_IDS) {
    const connection = siteConnection(env, id);
    if (connection.state !== "connected") continue;
    const { origin } = connection;
    const record = last?.sites[origin];
    const at = record ? Date.parse(record.at) : 0;
    const wait = record?.findings.length ? PROBE_RETRY_MS : PROBE_EVERY_MS;
    if ((!record || now.getTime() - at >= wait) && (!next || at < next.at))
      next = { id, origin, at };
  }
  return next;
}

async function lastProbe(env: Env): Promise<ProbeRecord | null> {
  try {
    const row = await drizzle(env.DB)
      .select()
      .from(reports)
      .where(eq(reports.name, PROBE_REPORT))
      .get();
    return row ? (JSON.parse(row.body) as ProbeRecord) : null;
  } catch {
    return null;
  }
}

/** The probed site's findings replace its record; every other site carries its last probe's. */
async function settleProbe(
  env: Env,
  results: CheckResult[],
  last: ProbeRecord | null,
  probedOrigin: string | undefined,
  now: Date,
): Promise<CheckResult[]> {
  const sites: ProbeRecord["sites"] = { ...last?.sites };
  const fresh = results.find((r) => r.conformance && r.conformance.origin === probedOrigin);
  if (fresh?.conformance) {
    const at = now.toISOString();
    sites[fresh.conformance.origin] = {
      at,
      findings: fresh.conformance.findings.filter((f) => f.detail.includes(PROBE_STEP)),
    };
    const body = JSON.stringify({ sites } satisfies ProbeRecord);
    try {
      await drizzle(env.DB)
        .insert(reports)
        .values({ name: PROBE_REPORT, body, at })
        .onConflictDoUpdate({ target: reports.name, set: { body, at } });
    } catch (error) {
      logEvent("health.probe-record-failed", { error: errorMessage(error) }, { level: "error" });
    }
  }
  return results.map((r) => {
    if (!r.conformance || r === fresh) return r;
    const carried = sites[r.conformance.origin]?.findings ?? [];
    if (!carried.length) return r;
    return {
      ...r,
      ok: false,
      detail: `${r.detail}${r.ok ? ` ${carried.length} probe post step(s) failed at the last probe.` : ""}`,
      conformance: {
        origin: r.conformance.origin,
        status: "fail",
        findings: [...r.conformance.findings, ...carried],
      },
    };
  });
}

/**
 * The scoreboard's report: every connected site's conformance, keyed by its origin. A site not
 * connected yet is left out, so the scoreboard, not this report, decides whether that is expected.
 */
function conformanceReport(results: CheckResult[], at: string) {
  const sites: Record<string, SiteConformance> = {};
  for (const r of results)
    if (r.conformance)
      sites[r.conformance.origin] = {
        status: r.conformance.status,
        findings: r.conformance.findings,
      };
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
    await db
      .insert(reports)
      .values({ name: "conformance", body, at })
      .onConflictDoUpdate({ target: reports.name, set: { body, at } });
  } catch (error) {
    logEvent("health.report-failed", { error: errorMessage(error) }, { level: "error" });
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
    const sent = await sendEmail(env.EMAIL, {
      from: env.ALERT_FROM,
      to: env.ALERT_EMAIL,
      subject:
        failing.length === 0
          ? "Carrel: all checks pass"
          : `Carrel: ${plural(failing.length, "check")} failing`,
      text: results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`).join("\n"),
    });
    if (!sent.sent) return { results, emailed: false };
    emailed = true;
  }

  const at = now().toISOString();
  try {
    for (const r of new Set([...changed, ...unseen])) {
      await db
        .insert(healthState)
        .values({ checkName: r.name, ok: r.ok, detail: r.detail, changedAt: at })
        .onConflictDoUpdate({
          target: healthState.checkName,
          set: { ok: r.ok, detail: r.detail, changedAt: at },
        });
    }
  } catch (error) {
    logEvent("health.record-failed", { error: errorMessage(error) }, { level: "error" });
  }
  return { results, emailed };
}

/**
 * GET /health, the one answer on both hosts (site-runtime's siteHealthResponse). On the AI door it is outside Access, so it
 * says only what any family site says in public: D1 answers, the bindings are there, the dump's age, the crons, the deployed
 * commit the live gate waits for, and the names (never the details) of the failing checks above.
 *
 * Levels. Only D1 (`db`) is fail level: without it neither door can find a person, so a 503 is the truth. Everything else
 * is warn and answers 200:
 * - oauth-kv, doc-room, mcp-rate-limit and tool-call-log each break one feature (the AI door, co-editing) while Desk still
 *   serves every page and save, so a 503 would call Carrel down while it works. The warn still reaches Capsid's watcher.
 *   The Durable Object checks only bind and mint an id; no object is woken or billed.
 * - email is checked present only: sending a probe would mail Dustin every few minutes.
 * - audit-bucket is one `head` on AUDIT_BUCKET, never a list.
 * Left out: CSP_REPORT_RATE_LIMIT, because a probe would spend a count and a missing binding only drops reports. BACKUPS is
 * the backup check's own read.
 */
export function deskHealthAnswer(env: Env): Promise<Response> {
  return siteHealthResponse(env, {
    backup: () => backupStatus(env),
    jobs: ALL_JOBS,
    checks: [
      { ...kvCheck("oauth-kv", env.OAUTH_KV), level: "warn" },
      durableObjectCheck("doc-room", env.DOC_ROOM),
      durableObjectCheck("mcp-rate-limit", env.MCP_RATE_LIMIT),
      // The tool-call log (warn with an alert): a call with no finished row, a spike, or rows not copied for two days.
      auditLogCheck(env),
      // AUDIT_BUCKET answers: a head of one key (no list), warn like the rest; a throw (an unbound binding included) fails it.
      { ...r2Check("audit-bucket", env.AUDIT_BUCKET), level: "warn" },
      emailCheck("email", env.EMAIL),
      // The last real AI writing call failed (a spend cap, a revoked key): the settings above still look fine then.
      aiOutcomeCheck("writing", env.OAUTH_KV),
      // Each job with its own interval, so one that never ran (a trigger that does not fire it) warns too. Held back
      // until its window has passed since this version was deployed.
      {
        name: "alerts",
        level: "warn",
        // Desk's own alert state. The `site-*` checks are other sites' conformance, which goes wrong for a while after every
        // site-api release; each has its own report finding and email, and listing them here made Desk read degraded to the watcher.
        run: async () => {
          const failing = await drizzle(env.DB)
            .select({ name: healthState.checkName })
            .from(healthState)
            .where(and(eq(healthState.ok, false), notLike(healthState.checkName, "site-%")))
            .all();
          return (
            failing.length === 0 || {
              ok: false,
              detail: `Failing: ${failing.map((f) => f.name).join(", ")}.`,
            }
          );
        },
      },
    ],
  });
}
