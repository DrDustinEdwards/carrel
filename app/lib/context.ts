import { createContext, type RouterContextProvider } from "react-router";

import type { Viewer } from "~/lib/people.server";

export const cloudflareContext = createContext<{ env: Env; ctx: ExecutionContext }>();

/** Set by the gate before any route runs. A route never sees a request without one. */
export const viewerContext = createContext<Viewer>();

export function getEnv(context: Readonly<RouterContextProvider>): Env {
  return context.get(cloudflareContext).env;
}

export function getViewer(context: Readonly<RouterContextProvider>): Viewer {
  return context.get(viewerContext);
}
