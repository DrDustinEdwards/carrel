// Scopes (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.3). The names are the family's one scheme, site-runtime's
// mcpScopes("carrel"): carrel.read and carrel.write. Least scope first (checklist A11): every grant holds
// read, and write only when the person ticks it on the consent page. The box starts ticked only when the client asked
// for carrel.write; a client that asks for carrel.read, or names no Carrel scope at all, starts unticked, and the person
// can tick it. (This replaces the 2026-10-10 default, where naming no scope started the box ticked.)
// What a session may do is still decided by the person's role below this layer: a scope can only narrow that, never
// widen it.
//
// Grants are stored with the scope strings they were issued with, so the earlier names still count: "carrel:read" and
// "carrel:write" (2026-10-10 to 2026-10-31) read as the new names, and "carrel" (before 2026-10-10, approved on a consent
// page that named writing) reads as both, until each grant is replaced at its next sign-in.

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
 * What the consent page offers. Read and write when the client asked for write (by today's name or an
 * earlier one, which a client that connected before may still send); otherwise, a request for read or
 * for no Carrel scope at all, reading only. The person's tick decides the grant.
 */
export function grantScopes(requested: readonly string[], opts: { readOnly?: boolean } = {}): string[] {
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
