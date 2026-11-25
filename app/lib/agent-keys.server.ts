// Named agent keys, for AI agents that cannot complete the door's OAuth sign-in: one Worker secret per agent, and the
// secret's NAME is the agent (AGENT_KEY_GROK is "grok").
//
// The name is never taken from the request: it is which configured secret the presented key matched, so a caller can
// prove it holds a key and never choose what it is called. site-runtime's agentPrincipal does the matching; this file
// holds how Carrel names and credits an agent. What the agent may do comes from the person row "agent:<name>" in People,
// never from the key.

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

/** The email an agent's person row carries. Not an address: no mailbox, and Access can never present it. */
export function agentEmail(name: string): string {
  return `agent:${name}`;
}
