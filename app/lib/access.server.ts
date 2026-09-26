// Identity comes only from the Access token Cloudflare puts on every request it lets through.
//
// NOT ctx.access. A Worker with Static Assets (the Vite plugin adds them for React Router) runs
// behind a router Worker that does not pass ctx.access through, so this Worker verifies the
// Cf-Access-Jwt-Assertion header itself against the team's certs, issuer and AUD.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: "not-configured" | "no-token" | "invalid-token" | "no-email" };

/** The issuer exactly as Access writes it: the team domain with no trailing slash. */
export function teamIssuer(teamDomain: string): string {
  return teamDomain.trim().replace(/\/+$/, "");
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** The team's signing keys, fetched and cached by jose, one set per team domain. */
export function accessKeys(teamDomain: string): JWTVerifyGetKey {
  const issuer = teamIssuer(teamDomain);
  let keys = remoteKeys.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeys.set(issuer, keys);
  }
  return keys;
}

/**
 * Verifies the request's Access token. Every failure is a refusal: a missing setting, a missing
 * header, a bad signature, the wrong issuer or audience, an expired token, or a token with no email.
 */
export async function verifyAccess(
  request: Request,
  config: { teamDomain: string | undefined; audience: string | undefined },
  keys: JWTVerifyGetKey,
): Promise<AccessResult> {
  const teamDomain = config.teamDomain?.trim();
  const audience = config.audience?.trim();
  if (!teamDomain || !audience) return { ok: false, reason: "not-configured" };

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, reason: "no-token" };

  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: teamIssuer(teamDomain),
      audience,
      algorithms: ["RS256"],
    }));
  } catch {
    return { ok: false, reason: "invalid-token" };
  }

  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email) return { ok: false, reason: "no-email" };
  return { ok: true, email };
}
