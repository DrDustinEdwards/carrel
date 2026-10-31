// The public site's Worker: sends plain HTTP to HTTPS, receives Content-Security-Policy violation reports at /csp-report with
// site-runtime's shared receiver (logged to Workers Logs, nothing stored), serves site-runtime's prefetch rules, and serves
// everything else from the static assets in www/dist, with the page's preload and Speculation-Rules headers on HTML. The
// writing app (Desk) is a separate Worker behind Cloudflare Access; this one holds no binding to it.

import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";
import { UNCACHED } from "@dustinedwards/site-runtime/edge-cache";
import { SPECULATION_RULES_HEADER, SPECULATION_RULES_PATH, speculationRulesResponse } from "@dustinedwards/site-runtime/prefetch";
import { withPreloadHeader } from "@dustinedwards/site-runtime/preload";
import { canonicalRedirect } from "@dustinedwards/site-runtime/url";
import { PAGE_PRELOADS, REPORT_PATH, SITE_HEADERS as HEADERS } from "./headers.mjs";

/** @param {Response} response */
const withHeaders = (response) => {
  for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
  return response;
};

export default {
  /**
   * @param {Request} request
   * @param {{
   *   ASSETS: { fetch(request: Request): Promise<Response> },
   *   CSP_REPORT_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> },
   * }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    // One hop to the canonical address: https, no trailing slash.
    const redirect = canonicalRedirect(request);
    if (redirect) return withHeaders(redirect);
    if (url.pathname === REPORT_PATH) {
      const allow = async (/** @type {Request} */ r) =>
        (await env.CSP_REPORT_RATE_LIMIT.limit({ key: r.headers.get("CF-Connecting-IP") ?? "unknown" })).success;
      return receiveCspReport(request, { headers: HEADERS, allow });
    }
    // The prefetch rules the page's header names (site-runtime ./prefetch): the next page starts loading on hover.
    if (url.pathname === SPECULATION_RULES_PATH) return withHeaders(speculationRulesResponse(undefined, request));
    const asset = await env.ASSETS.fetch(request);
    if (!(asset.headers.get("Content-Type") ?? "").startsWith("text/html")) return asset;
    const page = new Response(asset.body, asset);
    page.headers.set(SPECULATION_RULES_HEADER.name, SPECULATION_RULES_HEADER.value);
    // The 404 page is never stored; _headers gives every file the same short public cache.
    if (page.status >= 400) page.headers.set("Cache-Control", UNCACHED);
    // Early Hints: the zone answers a page carrying a preload Link header with a 103 first (site-runtime ./preload).
    return withPreloadHeader(page, PAGE_PRELOADS.header);
  },
};
