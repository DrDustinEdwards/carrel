import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { refreshGoogle } from "~/lib/google/refresh.server";
import { runHealth } from "~/lib/health.server";
import { reportInbox } from "~/lib/inbox-report.server";
import { aiDoor, isMcpHost } from "~/lib/mcp/door";
import { refreshAllSites } from "~/lib/refresh.server";
import { siteOrigins } from "~/lib/sites.server";
import { processSocial } from "~/lib/social/queue.server";

import { newNonce, withPolicy } from "./csp";
import { gate } from "./gate";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    // Two doors, told apart by the hostname alone. The AI door (carrel-mcp.dustinedwards.info) speaks
    // OAuth and MCP and nothing else; the pages are never served there. Everything else is the
    // browser door, behind Access.
    if (isMcpHost(request, env)) return aiDoor(request, env, ctx);
    return gate(request, env, async (req, viewer) => {
      const nonce = newNonce();
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx });
      context.set(viewerContext, viewer);
      context.set(nonceContext, nonce);
      return withPolicy(await requestHandler(req, context), nonce, siteOrigins(env));
    });
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runHealth(env));
    ctx.waitUntil(refreshAllSites(env));
    ctx.waitUntil(refreshGoogle(env));
    ctx.waitUntil(reportInbox(env));
    ctx.waitUntil(processSocial(env).catch((error) => console.error(JSON.stringify({ social: "tick-failed", error: String(error) }))));
  },
} satisfies ExportedHandler<Env>;
