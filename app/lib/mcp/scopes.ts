// Scopes (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.3): site-runtime's mcpScopes("carrel"), carrel.read and carrel.write.
// Every grant holds read, and write only when the person ticks it on the consent page; the box starts ticked only when the
// client asked for carrel.write. What a session may do is still decided by the person's role below this layer: a scope can
// only narrow that.
//
// Grants keep the scope strings they were issued with, so "carrel:read" and "carrel:write" read as the new names, and the
// original "carrel" (approved on a consent page that named writing) reads as both, until the grant is replaced at its next sign-in.

import { mcpScopes } from "@dustinedwards/site-runtime/mcp-server";

const CARREL_SCOPES = mcpScopes("carrel");
export const SCOPE_READ = CARREL_SCOPES.read;
export const SCOPE_WRITE = CARREL_SCOPES.write;

/** Earlier scope strings still held by live grants, and what each now means. */
const EARLIER_SCOPES: Readonly<Record<string, readonly string[]>> = {
  carrel: [SCOPE_READ, SCOPE_WRITE],
  "carrel:read": [SCOPE_READ],
  "carrel:write": [SCOPE_WRITE],
};

/** The scopes the authorization server offers, in the order the consent page names them. */
export const SCOPES_SUPPORTED: string[] = [...CARREL_SCOPES.all];

/** A scope list with every earlier name read as today's. */
function current(scopes: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const scope of scopes) for (const name of EARLIER_SCOPES[scope] ?? [scope]) out.add(name);
  return out;
}

/**
 * What the consent page offers: read and write when the client asked for write (by any of its names), otherwise reading
 * only. The person's tick decides the grant.
 */
export function grantScopes(
  requested: readonly string[],
  opts: { readOnly?: boolean } = {},
): string[] {
  if (opts.readOnly) return [SCOPE_READ];
  const asked = current(requested);
  return asked.has(SCOPE_WRITE) ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
}

/** The scopes a token's grant carries, with every earlier name read as today's. */
export function effectiveScopes(granted: readonly string[]): string[] {
  return [...current(granted)].filter((scope) => SCOPES_SUPPORTED.includes(scope));
}

/** Every scope, for a named agent key: its reach is its People row's role, set by Dustin. */
export const AGENT_SCOPES = [SCOPE_READ, SCOPE_WRITE];
