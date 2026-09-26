import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, viewerContext } from "~/lib/context";
import { runHealth } from "~/lib/health.server";

import { gate } from "./gate";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    return gate(request, env, (req, viewer) => {
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx });
      context.set(viewerContext, viewer);
      return requestHandler(req, context);
    });
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runHealth(env));
  },
} satisfies ExportedHandler<Env>;
