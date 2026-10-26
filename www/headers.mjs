// The public site's security headers and page policy, from site-runtime's builders: www/worker.mjs sends them on its own
// responses, and www/build.mjs writes them into dist/_headers for the static assets, which never run the Worker.
import { buildContentSecurityPolicy, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";

export const REPORT_PATH = "/csp-report";

/** Nothing unlisted, no forms, no script (the page has none), and Cloudflare Web Analytics. */
export const PAGE_CSP = buildContentSecurityPolicy({
  denyUnlisted: true,
  noForms: true,
  sources: { img: ["data:"], connect: ["https://cloudflareinsights.com"] },
  styleAttributesInline: true,
  cloudflareWebAnalytics: true,
  extraDirectives: ["style-src-elem 'self'"],
  reportUri: REPORT_PATH,
  reportTo: "csp-endpoint",
}).value;

export const REPORTING_ENDPOINTS = reportingEndpoints("csp-endpoint", new URL(REPORT_PATH, "https://carrel.dustinedwards.info"));

/** Every security header the site sends: site-runtime's standard set with the page policy and its report endpoint. */
export const SITE_HEADERS = Object.freeze({
  ...buildSecurityHeaders(),
  "Content-Security-Policy": PAGE_CSP,
  "Reporting-Endpoints": REPORTING_ENDPOINTS,
});
