// The Desk's chart demo (devkit live/areas.json, area 10): /demos/progress, the book page's progress chart
// drawn with sample words (app/routes/demos.progress.tsx), served to anyone, before the door, so a live check
// and a visitor see the chart a signed-in writer sees. Only that path, only GET and HEAD: any other request,
// a POST to the same path included, goes through the door as before. It reads no viewer and nothing from D1.
//
// Cloudflare Access stands in front of all of desk.dustinedwards.info (carrel-desk-login, docs/coediting.md),
// so the path is reachable only once the Access application `carrel-desk-public` bypasses `/demos` and
// `/assets` (the built app's hashed files, the public repository's own code), as carrel-mcp's Bypass app does
// for that host (docs/coediting.md, "The public paths").

import { applyHeaderSet } from "@dustinedwards/site-runtime/headers";

const DEMO_PATHS = new Set(["/demos/progress"]);

export function isDemo(request: Request): boolean {
  return (request.method === "GET" || request.method === "HEAD") && DEMO_PATHS.has(new URL(request.url).pathname);
}

/** The demo page's caching and indexing: never stored, never indexed. */
export function demoHeaders(response: Response): Response {
  return applyHeaderSet(response, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
}
