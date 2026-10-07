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

/** The prefix that makes a Worker secret an agent key. */
export const AGENT_KEY_PREFIX = "AGENT_KEY_";

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

async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * Constant-time equality over fixed-size SHA-256 digests, so the time taken says nothing about the
 * key's length or how much of it was right. crypto.subtle.timingSafeEqual where the runtime has it
 * (Workers does), else a byte loop over the two 32-byte digests.
 */
export async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  const native = (crypto.subtle as { timingSafeEqual?: (x: BufferSource, y: BufferSource) => boolean }).timingSafeEqual;
  if (typeof native === "function") return native.call(crypto.subtle, a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Which agent, if any, presented this Authorization header. Null for a missing or malformed header,
 * for any key that matches no configured secret (an OAuth access token is one of these), and when no
 * AGENT_KEY_* secret exists at all: the door is then exactly what it was. Null always means "fall
 * through to OAuth", never "this is an agent".
 *
 * A secret that is blank, or whose name is not a valid agent name, is skipped, so an empty secret
 * cannot become a master key. Every candidate is compared, with no early exit, so the time taken
 * does not depend on which key matched or where it sat.
 */
export async function agentPrincipal(env: object, authorization: string | null): Promise<string | null> {
  if (!authorization) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(authorization.trim());
  if (!match) return null;
  const presented = match[1]!;

  let found: string | null = null;
  for (const [secret, value] of Object.entries(env)) {
    if (!secret.startsWith(AGENT_KEY_PREFIX)) continue;
    const name = secret.slice(AGENT_KEY_PREFIX.length).toLowerCase();
    if (!isAgentName(name) || typeof value !== "string" || !value.trim()) continue;
    if (await keysMatch(presented, value.trim())) found = name;
  }
  return found;
}
