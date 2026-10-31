// The route a request's log line names (site-runtime withRequestLog's `route`, area 8, L3): Desk's matched pattern, so
// /p/:project/e/:item groups every post's hits, and the AI door's few fixed paths. A path that matches nothing (a
// scanner's guess, a 404) names no route, so the field never carries a visitor's raw path. Kept in step with
// app/routes.ts by test/route.test.ts.

import { matchPath } from "react-router";

export const DESK_PATTERNS = [
  "/",
  "/p/:project",
  "/p/:project/new",
  "/p/:project/e/:item",
  "/p/:project/media",
  "/p/:project/flags",
  "/p/:project/voice",
  "/p/:project/not-found",
  "/p/:project/legal",
  "/p/:project/mentions",
  "/people",
  "/books/new",
  "/b/:project",
  "/b/:project/c/:chapter",
  "/b/:project/outliner",
  "/b/:project/corkboard",
  "/b/:project/h/*",
  "/b/:project/f/*",
  "/p/:project/e/:item/unpublish",
  "/p/:project/e/:item/ai/:id",
  "/p/:project/e/:item/history",
  "/manuscripts",
  "/social",
  "/p/:project/media/api",
  "/p/:project/posts/api",
  "/p/:project/mentions/api",
  "/p/:project/e/:item/preview",
  "/p/:project/e/:item/ai/:id/preview",
  "/b/:project/export/:format",
  "/b/:project/authorship",
  "/auth/google/:step",
] as const;

// Paths served outside React Router: the public health, a co-editor's socket, and the AI door's own (app/lib/mcp/door.ts,
// "Routes on this host"). Desk has no page at any of the AI door's paths, so one list serves both hosts.
const FIXED = ["/health", "/collab/*", "/mcp", "/mcp/*", "/authorize", "/callback", "/register", "/token", "/.well-known/*", "/reports/conformance.json", "/csp-report"];

/** The pattern a request matched, or undefined when it matched none. */
export function routeOf(request: Request): string | undefined {
  const { pathname } = new URL(request.url);
  for (const pattern of [...FIXED, ...DESK_PATTERNS]) if (matchPath(pattern, pathname)) return pattern;
  return undefined;
}
