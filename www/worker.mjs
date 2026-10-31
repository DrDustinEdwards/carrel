// The public site's Worker: site-runtime's staticSite, the one front door the family's static sites share. One hop to
// the canonical address (https, no trailing slash); Content-Security-Policy violation reports at /csp-report with
// site-runtime's shared receiver (logged to Workers Logs, nothing stored, limited by CSP_REPORT_RATE_LIMIT); the
// prefetch rules at /speculation-rules.json; and every page from www/dist with the Speculation-Rules, Server-Timing and
// preload Link headers (Early Hints) and the security set from www/headers.mjs. A path with no file gets the 404 page,
// private and never stored, and so does a page asked for with a cookie. www/wrangler.jsonc runs it first for every
// path but the fonts. The writing app (Desk) is a separate Worker behind Cloudflare Access; this one holds no binding
// to it.

// Every request writes one `request` line (site-runtime withRequestLog: cf-ray, method, path without the query, status
// and ms; 5xx at error, 4xx at warn), as on Desk (area 8, L3). The site has no deploy sha to report.

import { withRequestLog } from "@dustinedwards/site-runtime/log";
import { staticSite } from "@dustinedwards/site-runtime/static-site";
import { PAGE_PRELOADS, REPORT_PATH, SITE_HEADERS } from "./headers.mjs";

const site = staticSite({ headers: SITE_HEADERS, preload: PAGE_PRELOADS.header, reportPath: REPORT_PATH });

export default {
  fetch: withRequestLog(
    /** @param {Request} request @param {import("@dustinedwards/site-runtime/static-site").StaticSiteEnv} env */
    (request, env) => site.fetch(request, env),
  ),
};
