import { withAdminIdle } from "@dustinedwards/site-runtime/access";
import { ADMIN_LIST_PATH, adminListResponse } from "@dustinedwards/site-runtime/access-drift";
import { runJobs } from "@dustinedwards/site-runtime/cron";
import { logEvent, withRequestLog } from "@dustinedwards/site-runtime/log";
import { countNotFound, pruneNotFound } from "@dustinedwards/site-runtime/not-found";
import { withMcpHeaders } from "@dustinedwards/site-runtime/mcp-server";
import { carrelMcp } from "@dustinedwards/site-runtime/sites";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { runBackup } from "~/lib/backup.server";
import { CRON_JOBS, type JobName } from "~/lib/cron-schedule";
import { deployedSha } from "~/lib/deployed";
import { refreshGoogle } from "~/lib/google/refresh.server";
import { runHealth } from "~/lib/health.server";
import { runSignedInCrawl, type DeskAs } from "~/lib/signed-in-crawl.server";
import { reportInbox } from "~/lib/inbox-report.server";
import { aiDoor, isMcpHost, mcpOrigin } from "~/lib/mcp/door";
import { carrelOrigin } from "~/lib/mcp/server";
import { refreshAllSites } from "~/lib/refresh.server";
import { deskPeopleEmails } from "~/lib/people.server";
import { siteOrigins } from "~/lib/sites.server";
import { processSocial } from "~/lib/social/queue.server";

import { requireBookProject } from "~/lib/books.server";
import { requireSiteProject } from "~/lib/projects.server";
import { connectRoom } from "~/lib/rooms.server";

import { cspReport, isCspReport } from "./csp-report";
import { admit, gate, type Render } from "./gate";
import { newNonce, withSecurityHeaders } from "./security-headers";

export { DocRoom } from "./doc-room";
// The AI door's rate limiter and tool-call log, site-runtime's (app/lib/mcp/door.ts, server.ts).
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

/*
 * The AI door's headers, all from site-runtime: its registry entry's set, noindex and no-store, the consent page's
 * hashed-style policy, a load-nothing policy for everything else, both report sinks, and security.txt (the same contact
 * and expiry as the public page's, www/build.mjs; renew both together). Its CSP sink is cspReport, which answers CORS for
 * Desk's pages, so the wrapper's own is never reached.
 */
const door = withMcpHeaders<Env>((request, env, ctx) => aiDoor(request, env, ctx as ExecutionContext), {
  site: carrelMcp,
  securityTxt: { contact: "security@dustinedwards.info", expires: "2027-10-26T00:00:00Z" },
});

/**
 * Two doors, told apart by the hostname alone. The AI door (carrel-mcp.dustinedwards.info) speaks OAuth and MCP and
 * nothing else, plus the CSP report sink and the public conformance report; the pages are never served there.
 * Everything else is the browser door, behind Access. Every response on either carries the security headers
 * (workers/security-headers.ts), refusals and redirects included.
 */
async function doors(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (isMcpHost(request, env)) {
    if (isCspReport(request)) return cspReport(request, env, carrelOrigin(env));
    const response = await door(request, env, ctx);
    // The door's set says nofollow on every response; /health keeps site-runtime's own noindex, as every family site's does.
    if (new URL(request.url).pathname === "/health") response.headers.set("X-Robots-Tag", "noindex");
    return response;
  }
  const nonce = newNonce();
  // The Desk's people, hashed with a fresh salt, for the daily Access drift check (.github/workflows/access-drift.yml).
  // Before the gate, because the caller is carrel-desk-login's service token and not a person: adminListResponse answers
  // only a GET carrying that application's verified Access token from a service token, and 404 to everything else.
  if (new URL(request.url).pathname === ADMIN_LIST_PATH) {
    const list = await adminListResponse(request, env, { admins: await deskPeopleEmails(env.DB) });
    return deskHeaders(list, nonce, env);
  }
  const response = await gate(request, env, deskRender(env, ctx, nonce));
  return deskHeaders(response, nonce, env);
}

/** Desk's page, room or resource route for a viewer the door has admitted. */
function deskRender(env: Env, ctx: ExecutionContext, nonce: string): Render {
  return async (req, viewer) => {
    // A live editor's WebSocket into its file's room (rooms.server.ts): the same sign-in and role as the page.
    if (new URL(req.url).pathname.startsWith("/collab/")) {
      return connectRoom(req, env, viewer, (kind, slug) => (kind === "p" ? requireSiteProject(env.DB, viewer, slug, "read") : requireBookProject(env.DB, viewer, slug, "read"))).catch((error: unknown) => {
        if (error instanceof Response) return error;
        throw error;
      });
    }
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    context.set(viewerContext, viewer);
    context.set(nonceContext, nonce);
    return requestHandler(req, context);
  };
}

function deskHeaders(response: Response, nonce: string, env: Env): Response {
  return withSecurityHeaders(response, nonce, { imageOrigins: siteOrigins(env), reportOrigin: mcpOrigin(env) });
}

/** The browser door after Access, for the signed-in crawl: the same admission, page and headers a signed-in browser gets. */
function deskAs(env: Env, ctx: ExecutionContext): DeskAs {
  return async (request, viewer) => {
    const nonce = newNonce();
    return deskHeaders(await admit(request, viewer, deskRender(env, ctx, nonce)), nonce, env);
  };
}

async function fetchCounted(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = await doors(request, env, ctx);
  // Carrel's own 404s, on both doors, per path, referring host and day (site-runtime's ./not-found; kept 90 days by the
  // nightly prune). Only a GET's 404 counts, written in waitUntil, so it never holds or fails the response.
  countNotFound(env.DB, request, response, ctx);
  return response;
}

/** Each job's work, by its name in CRON_JOBS (app/lib/cron-schedule.ts). */
const WORK: Record<JobName, (env: Env, ctx: ExecutionContext) => Promise<unknown>> = {
  health: (env) => runHealth(env),
  "refresh-sites": (env) => refreshAllSites(env),
  "refresh-google": (env) => refreshGoogle(env),
  "inbox-report": (env) => reportInbox(env),
  social: (env) => processSocial(env),
  backup: (env) => runBackup(env),
  "prune-404": (env) => pruneNotFound(env.DB),
  "signed-in-crawl": (env, ctx) => runSignedInCrawl(env, deskAs(env, ctx)),
};

/*
 * Each trigger runs its own list (app/lib/cron-schedule.ts): each job in turn, isolated, cut off at its timeout and
 * recorded in cron_runs for /health's cron check (site-runtime's runJobs). The nightly trigger runs the dump, then the
 * 404 prune. A trigger with no list is a config and code mismatch: logged, and the invocation fails.
 */
async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  const jobs = CRON_JOBS[controller.cron];
  if (!jobs) {
    logEvent("cron_unknown_trigger", { cron: controller.cron }, { level: "error" });
    throw new Error(`No jobs for the cron trigger ${controller.cron}.`);
  }
  await runJobs(env.DB, jobs.map((job) => ({ ...job, run: () => WORK[job.name](env, ctx) })));
}

// An admin idle for an hour is signed out of Access (site-runtime ./access). Every request writes one `request` log line
// with its status and the deployed commit (site-runtime's withRequestLog).
export default {
  fetch: withRequestLog((request: Request, env: Env, ctx: ExecutionContext) => withAdminIdle(request, () => fetchCounted(request, env, ctx), { prefixes: ["/"] }), {
    sha: (env) => deployedSha(env),
  }),
  scheduled,
} satisfies ExportedHandler<Env>;
