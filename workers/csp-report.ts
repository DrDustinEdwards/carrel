// The Content-Security-Policy report sink, on the AI door (the one Carrel host outside Access, so a
// browser's report reaches it without a session). The receiver is the portfolio's shared one
// (@dustinedwards/site-runtime/csp-report): 204 to every POST, the body read to 16 KB and no further,
// at most 10 violations logged with URLs cut to origin and path, nothing stored. Pages on the browser
// host report here cross-origin: `report-uri` posts without a preflight, and `report-to` (the
// Reporting API) preflights, so the receiver answers CORS for Carrel's origin alone. The door has no
// limiter for reports (its only one counts client registrations in KV), so each isolate logs at most
// REPORTS_PER_MINUTE requests a minute and drops the rest, still with 204 (Grok audit 2026-10-21, CR-5).

import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";

import { CSP_REPORT_PATH, doorSecurityHeaders } from "./security-headers";

/** Whether a request is for the sink. */
export function isCspReport(request: Request): boolean {
  return new URL(request.url).pathname === CSP_REPORT_PATH;
}

const REPORTS_PER_MINUTE = 60;
let budget = { minute: 0, used: 0 };

/** Whether this isolate may log one more report request this minute. */
function withinBudget(): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  if (budget.minute !== minute) budget = { minute, used: 0 };
  return ++budget.used <= REPORTS_PER_MINUTE;
}

/** Receives one report request on the AI door, with CORS for Carrel's own pages. */
export function cspReport(request: Request, carrelOrigin: string): Promise<Response> {
  return receiveCspReport(request, { allow: withinBudget, allowOrigin: carrelOrigin, headers: doorSecurityHeaders });
}
