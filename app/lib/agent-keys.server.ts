// Named agent keys, for AI agents that cannot complete the door's OAuth sign-in (Grok Build could
// not do CIMD as of 2026-09-07). The pattern is dustinedwards-mcp's: one Worker secret per agent,
// and the secret's NAME is the agent. AGENT_KEY_GROK is the key for the agent "grok".
//
// The name is never taken from the request. It is a property of WHICH configured secret the
// presented key matched, so a caller proves it holds a key and can never choose what it is called.
//
// Who is knocking is site-runtime's agentPrincipal (./agent-keys), which the door calls; this file
// holds only how Carrel names and credits an agent. What that agent may do comes from the person
// row "agent:<name>" in Carrel's People table (people.server.ts, findAgentViewer), never from the
// key, and the functions every tool calls refuse what the role does not allow.

/** The shape of an agent's name: what follows the prefix, lower-cased. */
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
