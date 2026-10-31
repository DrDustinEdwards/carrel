// The public site's Worker: site-runtime's staticSite, the one front door the family's static sites share. One hop to
// the canonical address (https, no trailing slash); Content-Security-Policy violation reports at /csp-report with
// site-runtime's shared receiver (logged to Workers Logs, nothing stored, limited by CSP_REPORT_RATE_LIMIT); the
// prefetch rules at /speculation-rules.json; and every page from www/dist with the Speculation-Rules, Server-Timing and
// preload Link headers (Early Hints) and the security set from www/headers.mjs. A path with no file gets the 404 page,
// private and never stored, and so does a page asked for with a cookie. www/wrangler.jsonc runs it first for every
// path but the fonts. The writing app (Desk) is a separate Worker behind Cloudflare Access; this one holds no binding
// to it.

import { staticSite } from "@dustinedwards/site-runtime/static-site";
import { PAGE_PRELOADS, REPORT_PATH, SITE_HEADERS } from "./headers.mjs";

export default staticSite({ headers: SITE_HEADERS, preload: PAGE_PRELOADS.header, reportPath: REPORT_PATH });
