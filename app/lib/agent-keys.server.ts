// Named agent keys, for AI agents that cannot complete the door's OAuth sign-in (Grok Build could
// not do CIMD as of 2026-09-07). The pattern is dustinedwards-mcp's: one Worker secret per agent,
// and the secret's NAME is the agent. AGENT_KEY_GROK is the key for the agent "grok".
//
// The name is never taken from the request. It is a property of WHICH configured secret the
// presented key matched, so a caller proves it holds a key and can never choose what it is called.
//
// This file decides who is knocking, and nothing more. What that agent may do comes from the
// person row "agent:<name>" in Carrel's People table (people.server.ts, findAgentViewer), never
// from the key, and the functions every tool calls refuse what the role does not allow.

/** The shape of an agent's name: what follows AGENT_KEY_, lower-cased (site-runtime's agent-keys reads the same shape). */
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

/** The email an agent's person row carries. Not an address: no mailbox, and Access can never present it. */
export function agentEmail(name: string): string {
  return `agent:${name}`;
}

/** What the audit trail credits an agent's writes to: the same text as its person row's email. */
export function agentClient(name: string): string {
  return agentEmail(name);
}

/**
 * Which agent, if any, presented this Authorization header: site-runtime's shared agentPrincipal (checklist S6), the same
 * code every MCP server uses. Null for a missing or malformed header, for a key that matches no configured AGENT_KEY_*
 * secret (an OAuth access token is one), and when none exists, so null always means "fall through to OAuth". A blank or
 * misnamed secret is skipped, and every candidate is compared in constant time with no early exit.
 */
export { agentPrincipal } from "@dustinedwards/site-runtime/agent-keys";
