// The public site's preloads, from site-runtime's builder. Its security headers, page policy and the Report-Only policy
// beside it come from its registry entry (site-runtime ./sites, carrel): www/worker.mjs sends them on its own responses
// (staticSite), and www/build.mjs writes them into dist/_headers for the static assets (site-runtime-headers).
import { preloads } from "@dustinedwards/site-runtime/preload";

/**
 * What every page blocks on or paints first, sent as a preload Link (and so as Early Hints): the one stylesheet, the hero
 * heading's Schibsted Grotesk and the lead's Source Serif 4. www/build.mjs refuses a build that lacks one of them.
 */
export const PAGE_PRELOADS = preloads([
  { href: "/site.css", as: "style" },
  { href: "/fonts/schibsted-grotesk-latin-wght-normal.woff2", as: "font", type: "font/woff2" },
  { href: "/fonts/source-serif-4-latin-wght-normal.woff2", as: "font", type: "font/woff2" },
]);
