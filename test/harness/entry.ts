// The Worker the screen harness runs: the app's real request handler and security headers, with
// the Access gate replaced by a header that names the viewer. Test-only; nothing here is deployed.

import { createRequestHandler, RouterContextProvider } from "react-router";

import { requireBookProject } from "~/lib/books.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { findViewer } from "~/lib/people.server";
import { requireSiteProject } from "~/lib/projects.server";
import { connectRoom } from "~/lib/rooms.server";
import { siteOrigins } from "~/lib/sites.server";

import { newNonce, withSecurityHeaders } from "../../workers/security-headers";
import { HARNESS_OWNER, harness } from "./seed";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export { DocRoom } from "../../workers/doc-room";

export default {
  async fetch(request, env, ctx) {
    const world = await harness(env);
    // A WebSocket cannot carry the header, so the viewer may also be named in a cookie.
    const cookie = /(?:^|;\s*)harness-viewer=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const email = request.headers.get("x-harness-viewer") ?? (cookie ? decodeURIComponent(cookie) : HARNESS_OWNER);
    const viewer = await findViewer(world.env.DB, email);
    if (!viewer) return new Response("Forbidden", { status: 403 });
    if (new URL(request.url).pathname.startsWith("/collab/")) {
      return connectRoom(request, world.env, viewer, (kind, slug) => (kind === "p" ? requireSiteProject(world.env.DB, viewer, slug, "read") : requireBookProject(world.env.DB, viewer, slug, "read")));
    }
    const nonce = newNonce();
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: world.env, ctx });
    context.set(viewerContext, viewer);
    context.set(nonceContext, nonce);
    return withSecurityHeaders(await requestHandler(request, context), nonce, { imageOrigins: siteOrigins(world.env) });
  },
} satisfies ExportedHandler<Env>;
