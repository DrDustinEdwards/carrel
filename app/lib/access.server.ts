// Identity comes only from the Access token Cloudflare puts on every request it lets through.
//
// NOT ctx.access. A Worker with Static Assets (the Vite plugin adds them for React Router) runs
// behind a router Worker that does not pass ctx.access through, so this Worker verifies the
// Cf-Access-Jwt-Assertion header itself. The check (signature by the team's keys, issuer, AUD,
// RS256, 60 s skew) is @dustinedwards/site-runtime/access, the family's one copy; what is Carrel's
// is reading a person's email from the verified claims.

import { verifyAccessRequest, type AccessRefusal } from "@dustinedwards/site-runtime/access";
import type { KeySource } from "@dustinedwards/site-runtime/access-login";

export type AccessResult = { ok: true; email: string } | { ok: false; reason: AccessRefusal | "no-email" };

/**
 * Verifies the request's Access token against one Access application's audience. Every fault is a refusal with its
 * reason: a missing setting, a missing header, a bad signature, the wrong issuer or audience, an expired token, or a
 * token with no email. Keys that cannot be fetched throw. `keys` defaults to the team's published keys.
 */
export async function verifyAccess(
  request: Request,
  config: { teamDomain: string | undefined; audience: string | undefined },
  keys?: KeySource,
): Promise<AccessResult> {
  const verdict = await verifyAccessRequest(request, { teamDomain: config.teamDomain, audience: config.audience, keys });
  if (!verdict.ok) return verdict;
  const email = typeof verdict.claims.email === "string" ? verdict.claims.email.trim() : "";
  if (!email) return { ok: false, reason: "no-email" };
  return { ok: true, email };
}
