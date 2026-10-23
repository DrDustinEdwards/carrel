// Every security header Carrel sends, in one place: the portfolio's shared set from
// @dustinedwards/site-runtime (the OWASP Secure Headers Project's own values), Carrel's few
// deviations beside the reason for each, and the Content-Security-Policy built from the short list of
// what Carrel loads. workers/app.ts applies it to every response on both hosts, redirects and the
// gate's refusals included. Nothing else in the repo sets a security header, except a route that
// chooses its own policy on purpose (the preview, the print export), which is kept.

import { buildContentSecurityPolicy, buildPolicy, generateNonce } from "@dustinedwards/site-runtime/csp";
import { applyHeaderSet, buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";

/** Where browsers send violation reports: a path on the AI door, the one Carrel host outside Access. */
export const CSP_REPORT_PATH = "/csp-report";
/** The `report-to` group name, declared by the Reporting-Endpoints header. */
const CSP_REPORT_GROUP = "csp";

/** The browser host's set: the shared standard exactly. A header not overridden is OSHP's value. */
const securityHeaders: Readonly<Record<string, string>> = Object.freeze(buildSecurityHeaders());

/** The AI door's set: the standard with one deviation. */
export const doorSecurityHeaders: Readonly<Record<string, string>> = Object.freeze(
  buildSecurityHeaders({
    overrides: {
      "Cross-Origin-Opener-Policy": {
        value: null,
        reason:
          "AI clients (claude.ai among them) open /authorize in a popup and wait for it through window.opener; same-origin would sever that opener and the sign-in would never return.",
      },
    },
  }),
);

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
export function appPolicy(nonce: string, imageOrigins: string[] = [], reportOrigin = ""): string {
  return buildContentSecurityPolicy({
    nonce,
    sources: {
      // 'strict-dynamic': the nonced entry scripts load the route chunks.
      script: ["'strict-dynamic'"],
      img: ["data:", ...imageOrigins.filter(isHttpsOrigin)],
    },
    // The editor's palettes are placed with style attributes, which nonces do not cover.
    styleAttributesInline: true,
    // Carrel's hosts are excluded from Web Analytics, and HTML is sent no-transform, so the beacon is
    // never injected: the policy is not loosened for it.
    cloudflareWebAnalytics: false,
    // The preview iframe, which is Carrel's own route serving the site's page under its own policy.
    extraDirectives: ["frame-src 'self'"],
    reportUri: `${reportOrigin}${CSP_REPORT_PATH}`,
    reportTo: CSP_REPORT_GROUP,
  }).value;
}

/**
 * The AI door's policy. Its only page is the consent form, which has one inline <style> and no
 * script. form-action is left out on purpose: approving submits into a redirect chain (POST
 * /authorize, the Access sign-in, /callback, then the client's own redirect_uri), a browser checks
 * form-action on every hop, and the last hop is whatever any client names, so no list can be right
 * (capsid shipped form-action 'self' on its consent page and broke sign-in for 26 days).
 */
export const DOOR_POLICY = buildPolicy([
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  `report-uri ${CSP_REPORT_PATH}`,
  `report-to ${CSP_REPORT_GROUP}`,
]);

/** The response itself when its headers can be changed, else a copy that can (Response.redirect's cannot). */
function mutable(response: Response): Response {
  try {
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) });
  }
}

function apply(response: Response, set: Readonly<Record<string, string>>, policy: string, reportOrigin: string): Response {
  const out = mutable(response);
  // The preview alone may be framed, and only by Carrel itself: its route says SAMEORIGIN, and nothing
  // a route says can loosen framing further than that.
  const framedByCarrel = out.headers.get("X-Frame-Options")?.trim().toUpperCase() === "SAMEORIGIN";
  // A route that set its own policy (the sandboxed preview, the print export) keeps it.
  const ownPolicy = out.headers.has("Content-Security-Policy");
  applyHeaderSet(out.headers, set);
  if (framedByCarrel) out.headers.set("X-Frame-Options", "SAMEORIGIN");
  if (!ownPolicy) out.headers.set("Content-Security-Policy", policy);
  // Absolute: Reporting-Endpoints ignores a relative endpoint.
  out.headers.set("Reporting-Endpoints", `${CSP_REPORT_GROUP}="${reportOrigin}${CSP_REPORT_PATH}"`);
  return out;
}

/** Every response on the browser host: the shared set and the app policy for this request's nonce. */
export function withSecurityHeaders(
  response: Response,
  nonce: string,
  { imageOrigins = [], reportOrigin = "" }: { imageOrigins?: string[]; reportOrigin?: string } = {},
): Response {
  return apply(response, securityHeaders, appPolicy(nonce, imageOrigins, reportOrigin), reportOrigin);
}

/** Every response on the AI door: its set and its policy. */
export function withDoorSecurityHeaders(response: Response, doorOrigin: string): Response {
  return apply(response, doorSecurityHeaders, DOOR_POLICY, doorOrigin);
}
