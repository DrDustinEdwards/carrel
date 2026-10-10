// Least scope (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.3). A grant carries carrel:read by
// default; carrel:write only when the client asked for it and the person approved it on the consent
// page. What a session may do is still decided by the person's role below this layer: a scope can
// only narrow that, never widen it.
//
// The one scope a grant carried before 2026-10-10, "carrel", was approved on a consent page that
// named writing, so it reads as both until that grant is replaced at the next sign-in.

export const SCOPE_READ = "carrel:read";
export const SCOPE_WRITE = "carrel:write";
const LEGACY_SCOPE = "carrel";

/** The scopes the authorization server offers, in the order the consent page names them. */
export const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE];

/**
 * What a new grant carries: read always, and write when the client asked for it (or for the legacy
 * scope, which a client that connected before may still send) and the person did not narrow it to
 * reading. Asking for nothing, or only for scopes this server does not know, gets read alone.
 */
export function grantScopes(requested: readonly string[], opts: { readOnly?: boolean } = {}): string[] {
  const asked = new Set(requested);
  if ((asked.has(SCOPE_WRITE) || asked.has(LEGACY_SCOPE)) && !opts.readOnly) return [SCOPE_READ, SCOPE_WRITE];
  return [SCOPE_READ];
}

/** The scopes a token's grant carries, with the legacy scope read as both. */
export function effectiveScopes(granted: readonly string[]): string[] {
  const out = new Set<string>();
  for (const scope of granted) {
    if (scope === LEGACY_SCOPE) {
      out.add(SCOPE_READ);
      out.add(SCOPE_WRITE);
    } else if (SCOPES_SUPPORTED.includes(scope)) out.add(scope);
  }
  return [...out];
}

/** Every scope, for a named agent key: its reach is its People row's role, set by Dustin. */
export const AGENT_SCOPES = [SCOPE_READ, SCOPE_WRITE];
