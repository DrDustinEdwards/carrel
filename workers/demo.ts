// The Desk's chart demo: /demos/progress, the book page's progress chart drawn with sample words (app/routes/demos.progress.tsx),
// served to anyone, before the door, so a live check and a visitor see the chart a signed-in writer sees. Only that path, only
// GET and HEAD: any other request goes through the door as before. It reads no viewer and nothing from D1.
//
// Access stands in front of all of desk.dustinedwards.info, so the path is reachable only once the Access application
// `carrel-desk-public` bypasses `/demos` and `/assets` (docs/coediting.md, "The public paths").

import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";

const DEMO_PATHS = new Set(["/demos/progress"]);

export function isDemo(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    DEMO_PATHS.has(new URL(request.url).pathname)
  );
}

/** The demo page's caching and indexing: never stored, never indexed. */
export function demoHeaders(response: Response): Response {
  return applyHeaderSet(response, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
}
