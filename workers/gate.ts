// The door every request passes. Nothing renders until Access has vouched for the request and the
// email it carries belongs to an active person in Carrel. Kept apart from app.ts so tests can drive
// it without the React Router build.
//
// There are two doors, told apart by the Access application that signed the token, never by email
// (design decision 2a). /mcp is the AI door: its token must come from the MCP Access application,
// where Managed OAuth signs AI clients in. Every other path is the browser door: its token must come
// from the Worker's own Access application. A browser token at /mcp, or an AI token anywhere else, is
// refused, so a browser session is never treated as AI and an AI session never reaches the buttons.

import type { JWTVerifyGetKey } from "jose";

import { accessKeys, verifyAccess } from "~/lib/access.server";
import { findViewer, type Viewer } from "~/lib/people.server";

export type Door = "browser" | "ai";

export type Render = (request: Request, viewer: Viewer, door: Door) => Promise<Response>;

/** The AI door's one path. MCP's Streamable HTTP transport uses a single endpoint. */
export const MCP_PATH = "/mcp";

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

export function doorFor(request: Request): Door {
  return new URL(request.url).pathname === MCP_PATH ? "ai" : "browser";
}

/**
 * The audience a door's token must carry. The AI door stays shut until ACCESS_MCP_AUD is set, and
 * shut if it is set to the browser's own AUD, which would let a browser session in as AI.
 */
function audienceFor(env: Env, door: Door): string | undefined {
  if (door === "browser") return env.ACCESS_AUD;
  const mcp = env.ACCESS_MCP_AUD?.trim();
  if (!mcp || mcp === env.ACCESS_AUD?.trim()) return undefined;
  return mcp;
}

export async function gate(
  request: Request,
  env: Env,
  render: Render,
  keys: JWTVerifyGetKey = accessKeys(env.ACCESS_TEAM_DOMAIN),
): Promise<Response> {
  const door = doorFor(request);
  let viewer: Viewer | null;
  try {
    const access = await verifyAccess(request, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: audienceFor(env, door) }, keys);
    if (!access.ok) return refuse(`${door}: ${access.reason}`);
    viewer = await findViewer(env.DB, access.email);
  } catch (error) {
    return refuse(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!viewer) return refuse("unknown-person");
  // A reviewer is an AI agent, not a person: it has no business at the browser door.
  if (viewer.isReviewer && door === "browser") return refuse("reviewer-at-browser-door");
  return withPrivateHeaders(await render(request, viewer, door));
}
