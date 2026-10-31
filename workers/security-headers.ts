// Every security header Carrel sends, in one place: the portfolio's shared set from
// @dustinedwards/site-runtime (the OWASP Secure Headers Project's own values), Carrel's few
// deviations beside the reason for each, and the Content-Security-Policy built from the short list of
// what Carrel loads. workers/app.ts applies it to every response on the browser host, redirects and
// the gate's refusals included; the AI door's come from site-runtime's withMcpHeaders. Nothing else
// sets a security header, except a route that chooses its own policy on purpose (the preview, the
// print export), which is kept.

import { CSP_REPORT_GROUP, buildContentSecurityPolicy, buildStagedPolicy, generateNonce, reportingEndpoints } from "@dustinedwards/site-runtime/csp";
import { applyHeaderSet, buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { carrelDesk, carrelMcp } from "@dustinedwards/site-runtime/sites";

/** Where browsers send violation reports: a path on the AI door, the one Carrel host outside Access. */
export const CSP_REPORT_PATH = "/csp-report";

/** The browser host's set: Desk's entry in site-runtime's registry (./sites), the shared standard exactly. */
export const securityHeaders: Readonly<Record<string, string>> = Object.freeze(buildSecurityHeaders({ site: carrelDesk }));

/** The AI door's set, for its CSP sink (csp-report.ts); withMcpHeaders (workers/app.ts) sets everything else there. */
export const doorSecurityHeaders: Readonly<Record<string, string>> = Object.freeze(buildSecurityHeaders({ site: carrelMcp }));

/** A nonce from the platform's randomness; a derived or fixed value would pass every test and protect nothing. */
export const newNonce = generateNonce;

/** An image origin as a policy may name it; anything else is dropped rather than failing every page. */
const isHttpsOrigin = (origin: string) => /^https:\/\/[^\s;,'"]+$/.test(origin);

/**
 * The policy for every page Carrel renders. Every response is private and `no-store`, so a fresh
 * nonce per request is sound; it goes on React Router's scripts and on CodeMirror's inline <style>,
 * which cannot be turned off.
 *
 * `imageOrigins` are the configured sites' origins: the media library and the editor show each file
 * from the site that serves it, and nothing else may load an image. `reportOrigin` is the AI door's
 * origin, whose /csp-report is reachable without an Access session.
 */
function pagePolicy(nonce: string, imageOrigins: string[], reportOrigin: string) {
  return {
    nonce,
    // 'strict-dynamic': the nonced entry scripts load the route chunks.
    strictDynamic: true,
    sources: {
      img: ["data:", ...imageOrigins.filter(isHttpsOrigin)],
    },
    // The editor's palettes are placed with style attributes, which nonces do not cover.
    styleAttributesInline: true,
    // Carrel's hosts are excluded from Web Analytics, and HTML is sent no-transform, so the beacon is
    // never injected: the policy is not loosened for it.
    cloudflareWebAnalytics: false,
    // The preview iframe is Carrel's own route serving the site's page under its own policy: default-src
    // 'self' covers it, so no frame-src is written (site-runtime 0.26.0 refuses a redundant one).
    reportUri: `${reportOrigin}${CSP_REPORT_PATH}`,
    reportTo: CSP_REPORT_GROUP,
  };
}

export function appPolicy(nonce: string, imageOrigins: string[] = [], reportOrigin = ""): string {
  return buildContentSecurityPolicy(pagePolicy(nonce, imageOrigins, reportOrigin)).value;
}

/**
 * The same policy with Trusted Types and default-src 'none' as Report-Only (Desk's registry entry stages both), so the
 * reports name each sink a page hands a string to and each kind it loads that the policy does not name.
 */
function stagedPolicy(nonce: string, imageOrigins: string[], reportOrigin: string): string {
  return buildStagedPolicy(pagePolicy(nonce, imageOrigins, reportOrigin), { trustedTypes: true, denyUnlisted: true }).value;
}

/**
 * The set stamped on a response, with the page policies unless the route set its own (the sandboxed preview, the print
 * export, which keep it), and the report group. applyHeaderSet rebuilds a response whose headers cannot be changed
 * (Response.redirect's) and hands a live editor's WebSocket (101) back as it is.
 */
function apply(response: Response, set: Readonly<Record<string, string>>, nonce: string, imageOrigins: string[], reportOrigin: string): Response {
  const ownPolicy = response.headers.has("Content-Security-Policy");
  return applyHeaderSet(response, {
    ...set,
    ...(ownPolicy
      ? {}
      : {
          "Content-Security-Policy": appPolicy(nonce, imageOrigins, reportOrigin),
          "Content-Security-Policy-Report-Only": stagedPolicy(nonce, imageOrigins, reportOrigin),
        }),
    ...(reportOrigin ? { "Reporting-Endpoints": reportingEndpoints(CSP_REPORT_GROUP, new URL(CSP_REPORT_PATH, reportOrigin)) } : {}),
  });
}

/** Every response on the browser host: the shared set and the app policy for this request's nonce. */
export function withSecurityHeaders(
  response: Response,
  nonce: string,
  { imageOrigins = [], reportOrigin = "" }: { imageOrigins?: string[]; reportOrigin?: string } = {},
): Response {
  return apply(response, securityHeaders, nonce, imageOrigins, reportOrigin);
}
