// Scopes (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.3). The names are the family's one scheme, site-runtime's
// mcpScopes("carrel"): carrel.read and carrel.write. A client that asks for carrel.read alone gets read alone. A client
// that asks for carrel.write, or names no Carrel scope at all, gets read and write (Dustin, 2026-10-10: a client that
// names no scope must not lose drafts and flags), and the person can always narrow it to reading on the consent page.
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
 * What a new grant carries. Reading only, when the person chose it on the consent page or the client
 * asked for carrel.read and nothing more. Otherwise read and write: the client asked for write (by
 * today's name or an earlier one, which a client that connected before may still send), or it named no
 * Carrel scope at all, which defaults to both.
 */
export function grantScopes(requested: readonly string[], opts: { readOnly?: boolean } = {}): string[] {
  if (opts.readOnly) return [SCOPE_READ];
  const asked = current(requested);
  if (asked.has(SCOPE_WRITE)) return [SCOPE_READ, SCOPE_WRITE];
  // Naming no Carrel scope at all defaults to both.
  if (!asked.has(SCOPE_READ)) return [SCOPE_READ, SCOPE_WRITE];
  return [SCOPE_READ];
}

/** The scopes a token's grant carries, with every earlier name read as today's. */
export function effectiveScopes(granted: readonly string[]): string[] {
  return [...current(granted)].filter((scope) => SCOPES_SUPPORTED.includes(scope));
}

/** Every scope, for a named agent key: its reach is its People row's role, set by Dustin. */
export const AGENT_SCOPES = [SCOPE_READ, SCOPE_WRITE];
