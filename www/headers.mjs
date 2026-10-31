// The public site's security headers and page policy, from site-runtime's builders: www/worker.mjs sends them on its own
// responses, and www/build.mjs writes them into dist/_headers for the static assets, which never run the Worker.
import { buildContentSecurityPolicy, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { TDM_RESERVATION_HEADERS } from "@drdustinedwards/site-helpers/robots";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";

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
  extraDirectives: ["manifest-src 'self'"],
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
