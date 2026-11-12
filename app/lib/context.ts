import { createContext, type RouterContextProvider } from "react-router";

import {
  cloudflareContext,
  cspNonceContext,
  getEnv,
  getNonce,
} from "@dustinedwards/site-runtime/context";

import type { Viewer } from "~/lib/people.server";

/** Set by the gate before any route runs. A route never sees a request without one. */
export const viewerContext = createContext<Viewer>();

/**
 * The visitor's likely time zone, from Cloudflare's reading of the request (request.cf.timezone), or UTC. The
 * writing progress panel counts its first render in it, so the browser's recount in the device's own zone, after
 * hydration, matches the server's HTML and moves nothing (Capsomer's WritingProgress, on the book's progress page).
 */
export const zoneContext = createContext<string>("UTC");

export function getZone(context: Readonly<RouterContextProvider>): string {
  return context.get(zoneContext);
}

export function getViewer(context: Readonly<RouterContextProvider>): Viewer {
  return context.get(viewerContext);
}

// The request context and the render nonce are site-runtime's (./context); re-exported so routes keep one import.
export { cloudflareContext, cspNonceContext, getEnv, getNonce };
