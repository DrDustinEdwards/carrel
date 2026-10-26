// The public site's Worker: sends plain HTTP to HTTPS, receives Content-Security-Policy violation reports at /csp-report with
// site-runtime's shared receiver (logged to Workers Logs, nothing stored), and serves everything else from the static assets in
// www/dist. The writing app (Desk) is a separate Worker behind Cloudflare Access; this one holds no binding to it.

import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";
import { REPORT_PATH, SITE_HEADERS as HEADERS } from "./headers.mjs";

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
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { ...HEADERS, Location: url.toString() } });
    }
    if (url.pathname === REPORT_PATH) {
      const allow = async (/** @type {Request} */ r) =>
        (await env.CSP_REPORT_RATE_LIMIT.limit({ key: r.headers.get("CF-Connecting-IP") ?? "unknown" })).success;
      return receiveCspReport(request, { headers: HEADERS, allow });
    }
    return env.ASSETS.fetch(request);
  },
};
