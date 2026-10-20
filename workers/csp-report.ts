// The Content-Security-Policy report sink, on the AI door (the one Carrel host outside Access, so a
// browser's report reaches it without a session). It logs one compact line per report and stores
// nothing. Pages on the browser host report here cross-origin: `report-uri` posts without a
// preflight, and `report-to` (the Reporting API) preflights, so OPTIONS answers for Carrel's origin.

import { CSP_REPORT_PATH } from "./security-headers";

const MAX_BYTES = 16 * 1024;

/** Whether a request is for the sink. */
export function isCspReport(request: Request): boolean {
  return new URL(request.url).pathname === CSP_REPORT_PATH;
}

/** One violation, reduced to what says which page broke and why. */
function summary(report: unknown): Record<string, unknown> {
  const r = (report && typeof report === "object" ? report : {}) as Record<string, unknown>;
  const body = (r["csp-report"] ?? r.body ?? r) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => body[k]).find((v) => typeof v === "string")?.toString().slice(0, 300);
  return {
    page: pick("document-uri", "documentURL"),
    directive: pick("effective-directive", "effectiveDirective", "violated-directive"),
    blocked: pick("blocked-uri", "blockedURL"),
    disposition: pick("disposition"),
  };
}

export async function cspReport(request: Request, carrelOrigin: string): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": carrelOrigin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  if (Number(request.headers.get("Content-Length") ?? MAX_BYTES + 1) > MAX_BYTES) return new Response(null, { status: 413, headers: cors });
  // Decoded by hand: report bodies are application/csp-report or application/reports+json.
  const text = new TextDecoder().decode(await request.arrayBuffer()).slice(0, MAX_BYTES);
  let reports: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    reports = Array.isArray(parsed) ? parsed.slice(0, 20) : [parsed];
  } catch {
    reports = [];
  }
  for (const report of reports) console.warn(JSON.stringify({ csp: "violation", ...summary(report) }));
  return new Response(null, { status: 204, headers: cors });
}
