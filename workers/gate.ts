// The browser door. Nothing renders until Access has vouched for the request and the email it
// carries belongs to an active person in Carrel. Kept apart from app.ts so tests can drive it without
// the React Router build.
//
// This is the only door on carrel.dustinedwards.info. The AI door is a different hostname,
// carrel-mcp.dustinedwards.info, served by app/lib/mcp/door.ts and chosen in app.ts by the host
// alone (design decision 7, corrected 2026-09-27). So a browser session is never treated as AI, and
// an AI session never reaches the buttons: /mcp here is just a page that does not exist, behind
// Access like every other.

import type { JWTVerifyGetKey } from "jose";

import { accessKeys, verifyAccess } from "~/lib/access.server";
import { findViewer, type Viewer } from "~/lib/people.server";

export type Render = (request: Request, viewer: Viewer) => Promise<Response>;

const PRIVATE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function withPrivateHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  // The preview route alone may be framed, and only by Carrel itself; nothing can loosen it further.
  const framedByCarrel = response.headers.get("X-Frame-Options")?.toUpperCase() === "SAMEORIGIN";
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(name, value);
  if (framedByCarrel) out.headers.set("X-Frame-Options", "SAMEORIGIN");
  return out;
}

/** The same bare 403 for every refusal, so a caller learns nothing about why. The reason is logged. */
function refuse(reason: string): Response {
  console.warn(JSON.stringify({ gate: "refused", reason }));
  return withPrivateHeaders(
    new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
  );
}

export async function gate(
  request: Request,
  env: Env,
  render: Render,
  keys: JWTVerifyGetKey = accessKeys(env.ACCESS_TEAM_DOMAIN),
): Promise<Response> {
  let viewer: Viewer | null;
  try {
    const access = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }, keys);
    if (!access.ok) return refuse(access.reason);
    viewer = await findViewer(env.DB, access.email);
  } catch (error) {
    return refuse(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!viewer) return refuse("unknown-person");
  // A reviewer is an AI agent, not a person: it has no business at the browser door.
  if (viewer.isReviewer) return refuse("reviewer-at-browser-door");
  return withPrivateHeaders(await render(request, viewer));
}
