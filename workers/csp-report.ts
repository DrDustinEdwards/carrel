// The Content-Security-Policy report sink, on the AI door (the one Carrel host outside Access, so a browser's report reaches it
// without a session). The receiver is site-runtime's shared one: 204 to every POST, the body read to 16 KB, at most 10 violations
// logged with URLs cut to origin and path, nothing stored. Pages on the browser host report here cross-origin, so the receiver
// answers CORS for Carrel's origin alone. CSP_REPORT_RATE_LIMIT caps each client address; a report over it is dropped, still
// with 204.

import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";

import { CSP_REPORT_PATH } from "@dustinedwards/site-runtime/csp";

import { doorSecurityHeaders } from "./security-headers";

export function isCspReport(request: Request): boolean {
  return new URL(request.url).pathname === CSP_REPORT_PATH;
}

/** Receives one report request on the AI door, with CORS for Carrel's own pages. */
export function cspReport(request: Request, env: Env, carrelOrigin: string): Promise<Response> {
  // Keyed on the edge-set client address, which is counted and never logged.
  const allow = async (r: Request) =>
    (await env.CSP_REPORT_RATE_LIMIT.limit({ key: r.headers.get("CF-Connecting-IP") ?? "unknown" }))
      .success;
  return receiveCspReport(request, {
    allow,
    allowOrigin: carrelOrigin,
    headers: doorSecurityHeaders,
  });
}
