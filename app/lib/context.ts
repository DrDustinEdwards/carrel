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

export function getNonce(context: Readonly<RouterContextProvider>): string {
  return context.get(nonceContext);
}

export function getEnv(context: Readonly<RouterContextProvider>): Env {
  return context.get(cloudflareContext).env;
}

export function getViewer(context: Readonly<RouterContextProvider>): Viewer {
  return context.get(viewerContext);
}
