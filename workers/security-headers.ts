// Every security header Carrel sends: site-runtime's pageSecurity (the shared set, the nonced policy, its Report-Only
// companion, the report group) with only what is Carrel's here, each beside its reason. workers/app.ts applies it to
// every response on the browser host, redirects and the gate's refusals included; the AI door's come from
// site-runtime's withMcpHeaders. A route that chooses its own policy on purpose (the preview, the print export) keeps it,
// and the preview alone may be framed, by Carrel itself (X-Frame-Options SAMEORIGIN; pageSecurity replaces any looser value).

import { CSP_REPORT_PATH } from "@dustinedwards/site-runtime/csp";
import { buildSecurityHeaders } from "@dustinedwards/site-runtime/headers";
import { pageSecurity } from "@dustinedwards/site-runtime/page-headers";
import { carrelDesk, carrelMcp } from "@dustinedwards/site-runtime/sites";
import { TRUSTED_TYPES_NAMES } from "@dustinedwards/site-runtime/trusted-types";

import { mcpOrigin } from "~/lib/mcp/door";
import { siteOrigins } from "~/lib/sites.server";

/** The AI door's set, for its CSP sink (csp-report.ts); withMcpHeaders (workers/app.ts) sets everything else there. */
export const doorSecurityHeaders: Readonly<Record<string, string>> = Object.freeze(
  buildSecurityHeaders({ site: carrelMcp }),
);

/** An image origin as a policy may name it; anything else is dropped rather than failing every page. */
const isHttpsOrigin = (origin: string) => /^https:\/\/[^\s;,'"]+$/.test(origin);

/**
 * Every response is private and `no-store`, so a fresh nonce per request is sound; it goes on React Router's scripts
 * and on CodeMirror's inline <style>, which cannot be turned off. The images are the configured sites' origins (the
 * media library and the editor show each file from the site that serves it) and nothing else may load one. Reports go
 * to the AI door, whose /csp-report is reachable without an Access session.
 */
export const { withSecurityHeaders, nonceFor } = pageSecurity<Env>({
  set: buildSecurityHeaders({ site: carrelDesk }),
  policy: ({ nonce, env, staged }) => ({
    nonce,
    // 'strict-dynamic': the nonced entry scripts load the route chunks.
    strictDynamic: true,
    sources: {
      img: ["data:", ...(env ? siteOrigins(env).filter(isHttpsOrigin) : [])],
      // default-src 'none' no longer covers the editor's preview iframe once the stricter policy is staged, so the
      // Report-Only form names it ('self' plus Desk's origin). The enforced policy's default-src 'self' covers it.
      ...(staged ? { frame: [carrelDesk.origin] } : {}),
    },
    // The editor's palettes are placed with style attributes, which nonces do not cover.
    styleAttributesInline: true,
    // Carrel's hosts are excluded from Web Analytics, and HTML is sent no-transform, so the beacon is never injected.
    cloudflareWebAnalytics: false,
    // Trusted Types is enforced (site-runtime 0.132.0): only the named policies may hand a sink markup or script text.
    trustedTypes: TRUSTED_TYPES_NAMES,
  }),
  staged: { denyUnlisted: true },
  reportPath: CSP_REPORT_PATH,
  reportOrigin: ({ env }) => (env ? mcpOrigin(env) : undefined),
});
