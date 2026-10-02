// The Worker the screen harness runs: the app's real request handler and Content Security Policy, with
// the Access gate replaced by a header that names the viewer. Test-only; nothing here is deployed.

import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { findViewer } from "~/lib/people.server";
import { siteOrigins } from "~/lib/sites.server";

import { newNonce, withPolicy } from "../../workers/csp";
import { HARNESS_OWNER, harness } from "./seed";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default {
  async fetch(request, env, ctx) {
    const world = await harness(env);
    const email = request.headers.get("x-harness-viewer") ?? HARNESS_OWNER;
    const viewer = await findViewer(world.env.DB, email);
    if (!viewer) return new Response("Forbidden", { status: 403 });
    const nonce = newNonce();
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: world.env, ctx });
    context.set(viewerContext, viewer);
    context.set(nonceContext, nonce);
    return withPolicy(await requestHandler(request, context), nonce, siteOrigins(world.env));
  },
} satisfies ExportedHandler<Env>;
