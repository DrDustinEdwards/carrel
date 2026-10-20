// The Content-Security-Policy report sink, on the AI door (the one Carrel host outside Access, so a
// browser's report reaches it without a session). The receiver is the portfolio's shared one
// (@dustinedwards/site-runtime/csp-report): 204 to every POST, the body read to 16 KB and no further,
// at most 10 violations logged with URLs cut to origin and path, nothing stored. Pages on the browser
// host report here cross-origin: `report-uri` posts without a preflight, and `report-to` (the
// Reporting API) preflights, so the receiver answers CORS for Carrel's origin alone. No rate limiter
// is passed: the door's only limiter counts client registrations in KV, which is not one for reports.

import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";

import { CSP_REPORT_PATH, doorSecurityHeaders } from "./security-headers";

/** Whether a request is for the sink. */
export function isCspReport(request: Request): boolean {
  return new URL(request.url).pathname === CSP_REPORT_PATH;
}

/** Receives one report request on the AI door, with CORS for Carrel's own pages. */
export function cspReport(request: Request, carrelOrigin: string): Promise<Response> {
  return receiveCspReport(request, { allowOrigin: carrelOrigin, headers: doorSecurityHeaders });
}
