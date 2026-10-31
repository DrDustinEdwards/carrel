// The browser door. Nothing renders until Access has vouched for the request and the email it
// carries belongs to an active person in Carrel. Kept apart from app.ts so tests can drive it without
// the React Router build.
//
// One path is public: /health, the shared health with the deployed commit, which Capsid's watcher and
// the deploy's checks read with no sign-in (area 8, H1). It names checks, never a person or a page.
// Cloudflare Access lets it through by its own Bypass application for desk.dustinedwards.info/health.
//
// This is the only door on desk.dustinedwards.info. The AI door is a different hostname,
// carrel-mcp.dustinedwards.info, served by app/lib/mcp/door.ts and chosen in app.ts by the host
// alone (design decision 7, corrected 2026-09-27). So a browser session is never treated as AI, and
// an AI session never reaches the buttons: /mcp here is just a page that does not exist, behind
// Access like every other.

import type { KeySource } from "@dustinedwards/site-runtime/access-login";
import { logEvent, OWASP_EVENTS, requestFields } from "@dustinedwards/site-runtime/log";
import { isolationVerdict, refuseCrossSite } from "@dustinedwards/site-runtime/origin";

import { verifyAccess } from "~/lib/access.server";
import { healthAnswer } from "~/lib/health.server";
import { findViewer, type Viewer } from "~/lib/people.server";

export type Render = (request: Request, viewer: Viewer) => Promise<Response>;

// Caching only. The security headers (HSTS, framing, nosniff, Referrer-Policy and the rest) are
// workers/security-headers.ts's, applied by app.ts to everything this returns, refusals included.
const PRIVATE_CACHE = "private, no-store";

function withPrivateHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  // An HTML page is left as it is: Cloudflare does not touch a response that says no-transform, which
  // keeps the Web Analytics beacon out of private pages (a dashboard exclusion needs the Pro plan).
  // Scripts, styles and fonts stay compressible. One Cache-Control header, never two.
  const html = out.headers.get("Content-Type")?.toLowerCase().startsWith("text/html");
  out.headers.set("Cache-Control", html ? `${PRIVATE_CACHE}, no-transform` : PRIVATE_CACHE);
  return out;
}

/** The same bare 403 for every refusal, so a caller learns nothing about why. The reason is logged. */
function refuse(request: Request, reason: string): Response {
  logEvent(OWASP_EVENTS.authorizationFailure, { door: "browser", reason, ...requestFields(request) }, { level: "warn" });
  return withPrivateHeaders(
    new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
  );
}

export async function gate(
  request: Request,
  env: Env,
  render: Render,
  keys?: KeySource,
): Promise<Response> {
  if (new URL(request.url).pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
    const health = withPrivateHeaders(await healthAnswer(env));
    health.headers.set("X-Robots-Tag", "noindex");
    return health;
  }
  let viewer: Viewer | null;
  try {
    const access = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, keys);
    if (!access.ok) return refuse(request, access.reason);
    viewer = await findViewer(env.DB, access.email);
  } catch (error) {
    return refuse(request, `error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!viewer) return refuse(request, "unknown-person");
  // A reviewer is an AI agent, not a person: it has no business at the browser door.
  if (viewer.isReviewer) return refuse(request, "reviewer-at-browser-door");
  // A change sent from another site's page. React Router checks Origin on a page's action, but not on a resource route's
  // (media, bulk, mentions), so the door checks every request once: Sec-Fetch-Site, else Origin. A request with
  // neither (curl, a server) passes.
  if (refuseCrossSite(request)) return refuse(request, "cross-origin");
  // Resource isolation (R2): every page here is signed in, so another site may link to one (a top-level GET navigation)
  // and nothing more. A cross-site image, script, frame, fetch or socket is refused, so no page elsewhere can load a
  // signed-in response with the viewer's Access cookie.
  if (!isolationVerdict(request).ok) return refuse(request, "cross-site-resource");
  const response = await render(request, viewer);
  // A live editor's WebSocket (101) is the socket itself: copying it would drop the socket.
  return response.status === 101 ? response : withPrivateHeaders(response);
}
