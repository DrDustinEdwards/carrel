import { withAdminIdle } from "@dustinedwards/site-runtime/access";
import { runJobs } from "@dustinedwards/site-runtime/cron";
import { withMcpHeaders } from "@dustinedwards/site-runtime/mcp-server";
import { carrelMcp } from "@dustinedwards/site-runtime/sites";
import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { BACKUP_CRON } from "~/lib/backup-checks";
import { runBackup } from "~/lib/backup.server";
import { refreshGoogle } from "~/lib/google/refresh.server";
import { runHealth } from "~/lib/health.server";
import { reportInbox } from "~/lib/inbox-report.server";
import { aiDoor, isMcpHost, mcpOrigin } from "~/lib/mcp/door";
import { carrelOrigin } from "~/lib/mcp/server";
import { refreshAllSites } from "~/lib/refresh.server";
import { siteOrigins } from "~/lib/sites.server";
import { processSocial } from "~/lib/social/queue.server";

import { requireBookProject } from "~/lib/books.server";
import { requireSiteProject } from "~/lib/projects.server";
import { connectRoom } from "~/lib/rooms.server";

import { cspReport, isCspReport } from "./csp-report";
import { gate } from "./gate";
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

const site = {
  async fetch(request, env, ctx) {
    // Two doors, told apart by the hostname alone. The AI door (carrel-mcp.dustinedwards.info) speaks
    // OAuth and MCP and nothing else, plus the CSP report sink and the public conformance report; the
    // pages are never served there.
    // Everything else is the browser door, behind Access. Every response on either carries the
    // security headers (workers/security-headers.ts), refusals and redirects included.
    if (isMcpHost(request, env)) return isCspReport(request) ? cspReport(request, env, carrelOrigin(env)) : door(request, env, ctx);
    const nonce = newNonce();
    const response = await gate(request, env, async (req, viewer) => {
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
    });
    if (response.status === 101) return response;
    return withSecurityHeaders(response, nonce, { imageOrigins: siteOrigins(env), reportOrigin: mcpOrigin(env) });
  },

  // Each job runs in turn, isolated, and is recorded in cron_runs for /health's cron check (site-runtime's runJobs).
  // The nightly cron runs the dump alone.
  async scheduled(controller, env) {
    if (controller.cron === BACKUP_CRON) return runJobs(env.DB, [{ name: "backup", everyMinutes: 1440, run: () => runBackup(env) }]);
    await runJobs(env.DB, [
      { name: "health", everyMinutes: 15, run: () => runHealth(env) },
      { name: "refresh-sites", everyMinutes: 15, run: () => refreshAllSites(env) },
      { name: "refresh-google", everyMinutes: 15, run: () => refreshGoogle(env) },
      { name: "inbox-report", everyMinutes: 15, run: () => reportInbox(env) },
      { name: "social", everyMinutes: 15, run: () => processSocial(env) },
    ]);
  },
} satisfies ExportedHandler<Env>;

// An admin idle for an hour is signed out of Access (site-runtime ./access).
export default {
  ...site,
  fetch: (request, env, ctx) => withAdminIdle(request, () => site.fetch(request, env, ctx), { prefixes: ["/"] }),
} satisfies ExportedHandler<Env>;
