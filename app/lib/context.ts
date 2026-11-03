import { createContext, type RouterContextProvider } from "react-router";

import type { Viewer } from "~/lib/people.server";

export const cloudflareContext = createContext<{ env: Env; ctx: ExecutionContext }>();

/** Set by the gate before any route runs. A route never sees a request without one. */
export const viewerContext = createContext<Viewer>();

/**
 * This render's CSP nonce. It must exist before the render: the same value goes in the header and on
 * every <script>. Set by workers/app.ts; the root loader hands it to Layout.
 */
export const nonceContext = createContext<string>();

/**
 * The visitor's likely time zone, from Cloudflare's reading of the request (request.cf.timezone), or UTC. The
 * writing progress panel counts its first render in it, so the browser's recount in the device's own zone, after
 * hydration, matches the server's HTML and moves nothing (app/components/writing/progress-panel.tsx).
 */
export const zoneContext = createContext<string>("UTC");

export function getZone(context: Readonly<RouterContextProvider>): string {
  return context.get(zoneContext);
}

export function getNonce(context: Readonly<RouterContextProvider>): string {
  return context.get(nonceContext);
}

export function getEnv(context: Readonly<RouterContextProvider>): Env {
  return context.get(cloudflareContext).env;
}

export function getViewer(context: Readonly<RouterContextProvider>): Viewer {
  return context.get(viewerContext);
}
