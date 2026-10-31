// The public site's security headers, page policy and preloads, from site-runtime's builders: www/worker.mjs sends them on
// its own responses, and www/build.mjs writes the headers into dist/_headers for the static assets.
import { buildContentSecurityPolicy, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { preloads } from "@dustinedwards/site-runtime/preload";

export const REPORT_PATH = "/csp-report";

/**
 * Nothing unlisted, no forms, scripts from this origin only (the theme switch, /theme.js and /site.js), and Cloudflare Web
 * Analytics. The beacon is injected by the edge (automatic setup), so it reports to this origin's /cdn-cgi/rum, which
 * connect-src's 'self' covers; cloudflareinsights.com is only for a hand-installed snippet (Cloudflare's Web Analytics FAQ).
 */
const PAGE_CSP = buildContentSecurityPolicy({
  denyUnlisted: true,
  noForms: true,
  sources: { img: ["data:"] },
  styleAttributesInline: true,
  cloudflareWebAnalytics: true,
  reportUri: REPORT_PATH,
  reportTo: "csp-endpoint",
}).value;

const REPORTING_ENDPOINTS = reportingEndpoints("csp-endpoint", new URL(REPORT_PATH, "https://carrel.dustinedwards.info"));

/**
 * Every header the site sends: site-runtime's standard security set with the page policy and its report endpoint, and
 * Prelum's TDMRep header reserving text and data mining rights (robots.txt and /ai.txt carry the rest of the policy).
 */
export const SITE_HEADERS = Object.freeze({
  ...buildSecurityHeaders(),
  ...TDM_RESERVATION_HEADERS,
  "Content-Security-Policy": PAGE_CSP,
  "Reporting-Endpoints": REPORTING_ENDPOINTS,
});

/**
 * What every page blocks on or paints first, sent as a preload Link (and so as Early Hints): the one stylesheet, the hero
 * heading's Schibsted Grotesk and the lead's Source Serif 4. www/build.mjs refuses a build that lacks one of them.
 */
export const PAGE_PRELOADS = preloads([
  { href: "/site.css", as: "style" },
  { href: "/fonts/schibsted-grotesk-latin-wght-normal.woff2", as: "font", type: "font/woff2" },
  { href: "/fonts/source-serif-4-latin-wght-normal.woff2", as: "font", type: "font/woff2" },
]);
