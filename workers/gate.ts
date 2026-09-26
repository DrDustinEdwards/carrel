// The door every request passes. Nothing renders until Access has vouched for the request and the
// email it carries belongs to an active person in Carrel. Kept apart from app.ts so tests can drive
// it without the React Router build.

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
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) out.headers.set(name, value);
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
    const access = await verifyAccess(
      request,
      { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD },
      keys,
    );
    if (!access.ok) return refuse(access.reason);
    viewer = await findViewer(env.DB, access.email);
  } catch (error) {
    return refuse(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!viewer) return refuse("unknown-person");
  return withPrivateHeaders(await render(request, viewer));
}
