// Tightened Dynamic Client Registration (ruling capsid/rulings/mcp-2026-10-10.md, rule 13), beside
// CIMD. Claude, Claude Code and ChatGPT identify themselves by a client metadata document; Grok and
// Gemini still register, as of 2026-10-09, so the door registers them under four limits:
//
//   1. Redirect URIs allowlisted exactly. A registration names only callbacks on the list below (or
//      in DCR_REDIRECT_URIS, for a callback that carries a per-connector id), compared as whole
//      strings: no prefix, no pattern, no localhost.
//   2. Registration grants nothing. It stores a client id and no grant, no token and no scope; the
//      client still has to send the person through the consent page and the Access sign-in, and the
//      person must be in Carrel. Only the authorization code and refresh grants exist here.
//   3. Consent per client. The consent page is shown on every authorization (nothing remembers an
//      approval), and for a registered client it says the name is the client's own claim.
//   4. Rate limited: a few registrations an hour from one address, and a ceiling a day for all.
//
// REMOVAL CONDITION: delete this file, and clientRegistrationEndpoint in door.ts, when Grok and
// Gemini sign in by CIMD, and at the latest when the MCP specification removes registration (after
// summer 2027).

/**
 * The callbacks a registered client may name. Grok's two are the ones its custom connectors have
 * been seen sending; ChatGPT's is its fixed (legacy) connector callback; Google's is the fixed
 * Gemini Enterprise redirect. A callback with an id in it (ChatGPT's per-connector one, the
 * consumer Gemini app's per-user one) is added exactly, in DCR_REDIRECT_URIS.
 */
export const DCR_REDIRECT_URIS: readonly string[] = [
  "https://grok.com/connectors/oauth/callback",
  "https://grok.com/connectors-oauth-exchange-code/",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://vertexaisearch.cloud.google.com/oauth-redirect",
];

/** Registrations one address may make in an hour, and all addresses together in a day. */
export const PER_ADDRESS_PER_HOUR = 5;
export const ALL_PER_DAY = 30;

export const REGISTER_PATH = "/register";

/**
 * The allowlist: the fixed callbacks, and the exact https callbacks in DCR_REDIRECT_URIS (space or
 * comma separated). Read loosely, like CARREL_MCP_ORIGIN: an older wrangler.jsonc has no such var.
 */
export function allowedRedirects(env: Env): Set<string> {
  const extra = ((env as { DCR_REDIRECT_URIS?: string }).DCR_REDIRECT_URIS ?? "")
    .split(/[\s,]+/)
    .filter((uri) => uri.startsWith("https://"));
  return new Set([...DCR_REDIRECT_URIS, ...extra]);
}

type Refusal = { code: string; description: string; status: number };

/** The registration policy, for the provider's clientRegistrationCallback: undefined lets it through. */
export function checkRegistration(allowed: ReadonlySet<string>, metadata: Record<string, unknown>): Refusal | undefined {
  const refuse = (description: string): Refusal => ({ code: "invalid_redirect_uri", description, status: 400 });
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) return refuse("redirect_uris must list one to five callbacks.");
  for (const uri of uris) {
    if (typeof uri !== "string" || !allowed.has(uri)) return refuse(`${String(uri).slice(0, 200)} is not a callback Carrel registers. Only the exact callbacks of the AI apps Dustin uses are allowed.`);
  }
  // Grant and response types need no check here: the provider refuses any but the code and refresh
  // grants itself (implicit flow, token exchange and client credentials are all off), and
  // door.test.ts pins that.
  return undefined;
}

/**
 * Counts one registration attempt against the limits, in OAUTH_KV. Answers the 429 to send, or null
 * to go on. KV is eventually consistent, so a burst across locations can pass a few over the line;
 * the limit is a brake on abuse, and the allowlist is what keeps a registration harmless.
 */
export async function registrationLimited(request: Request, env: Env, now = Date.now()): Promise<Response | null> {
  const kv = env.OAUTH_KV;
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const hour = Math.floor(now / 3_600_000);
  const day = Math.floor(now / 86_400_000);
  const keys = [
    { key: `dcr-rate:addr:${address}:${hour}`, limit: PER_ADDRESS_PER_HOUR, ttl: 3_700 },
    { key: `dcr-rate:all:${day}`, limit: ALL_PER_DAY, ttl: 86_500 },
  ];
  const counts = await Promise.all(keys.map(async (k) => Number((await kv.get(k.key)) ?? 0)));
  if (keys.some((k, i) => counts[i]! >= k.limit)) {
    console.warn(JSON.stringify({ door: "registration-limited", address }));
    return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "3600" },
    });
  }
  await Promise.all(keys.map((k, i) => kv.put(k.key, String(counts[i]! + 1), { expirationTtl: k.ttl })));
  return null;
}
