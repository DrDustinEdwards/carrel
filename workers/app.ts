import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { refreshGoogle } from "~/lib/google/refresh.server";
import { runHealth } from "~/lib/health.server";
import { handleMcp } from "~/lib/mcp/server";
import { refreshAllSites } from "~/lib/refresh.server";

import { newNonce, withPolicy } from "./csp";
import { gate } from "./gate";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    return gate(request, env, async (req, viewer, door) => {
      // The AI door speaks MCP and nothing else; the pages are never served to it.
      if (door === "ai") return handleMcp(req, env, viewer);
      const nonce = newNonce();
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx });
      context.set(viewerContext, viewer);
      context.set(nonceContext, nonce);
      return withPolicy(await requestHandler(req, context), nonce);
    });
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runHealth(env));
    ctx.waitUntil(refreshAllSites(env));
    ctx.waitUntil(refreshGoogle(env));
  },
} satisfies ExportedHandler<Env>;
