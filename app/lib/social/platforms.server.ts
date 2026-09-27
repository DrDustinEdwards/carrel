// The two platforms Carrel posts to, and the one way out to them. There is no reply or direct-message
// code (design section 5, "Social"), and a guard makes sure none can be reached: every request is
// checked against an allowlist of the exact endpoints that create a session or an original post,
// and a post body carrying a reply reference is refused before it is sent.
//
// Bluesky: carried over from legacy Recova's lib/social/bluesky.ts (app-password session reused for
// two hours, createRecord for the post), with its reply and search functions dropped and the session
// kept per account. X: OAuth 1.0a user context for POST /2/tweets, signed here with Web Crypto
// instead of Recova's twitter-api-v2 package.

type Fetch = typeof fetch;

export type Platform = "bluesky" | "x";

export type Credentials =
  | { platform: "bluesky"; handle: string; appPassword: string }
  | { platform: "x"; apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };

/** A refusal made before anything is sent: a reply, a message, or any endpoint not on the list. */
export class SocialRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialRefused";
  }
}

const BSKY = "https://bsky.social/xrpc";
const X_TWEETS = "https://api.x.com/2/tweets";

const ALLOWED = new Set([`POST ${BSKY}/com.atproto.server.createSession`, `POST ${BSKY}/com.atproto.repo.createRecord`, `POST ${X_TWEETS}`]);

/** The guard every request passes. Exported so the tests can plant against it directly. */
export function assertOriginalPost(method: string, url: string, body: unknown): void {
  if (!ALLOWED.has(`${method.toUpperCase()} ${url}`)) throw new SocialRefused(`${method} ${url} is not an original post; Carrel never replies, messages, follows or likes.`);
  const b = body as Record<string, unknown> | undefined;
  const record = b?.record as Record<string, unknown> | undefined;
  if (record && (record.reply !== undefined || record.$type !== "app.bsky.feed.post")) throw new SocialRefused("A Bluesky record that is a reply, or not a post, is refused.");
  if (b?.collection !== undefined && b.collection !== "app.bsky.feed.post") throw new SocialRefused(`Writing to ${String(b.collection)} is refused; only posts.`);
  if (url === X_TWEETS && (b?.reply !== undefined || b?.quote_tweet_id !== undefined || b?.direct_message_deep_link !== undefined)) {
    throw new SocialRefused("An X post that replies, quotes or links a direct message is refused.");
  }
}

async function send(fetcher: Fetch, method: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  assertOriginalPost(method, url, body);
  return fetcher(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

// ---------- Bluesky (from Recova)

const bskySessions = new Map<string, { accessJwt: string; did: string; expiresAt: number }>();

export function clearBlueskySessions(): void {
  bskySessions.clear();
}

async function blueskySession(creds: Extract<Credentials, { platform: "bluesky" }>, fetcher: Fetch, now: number) {
  const cached = bskySessions.get(creds.handle);
  // Re-authenticate when missing or within five minutes of expiry (Recova's rule).
  if (cached && now < cached.expiresAt - 5 * 60 * 1000) return cached;
  const res = await send(fetcher, "POST", `${BSKY}/com.atproto.server.createSession`, { identifier: creds.handle, password: creds.appPassword });
  if (!res.ok) throw new Error(`Bluesky sign-in ${res.status}`);
  const data = (await res.json()) as { accessJwt: string; did: string };
  // Bluesky access tokens last two hours.
  const session = { accessJwt: data.accessJwt, did: data.did, expiresAt: now + 2 * 60 * 60 * 1000 };
  bskySessions.set(creds.handle, session);
  return session;
}

/** Bluesky counts graphemes, not UTF-16 units. */
export function graphemes(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
}

async function postToBluesky(creds: Extract<Credentials, { platform: "bluesky" }>, text: string, fetcher: Fetch, now: number): Promise<string> {
  const session = await blueskySession(creds, fetcher, now);
  // A link is made clickable with a facet over its byte range, as the app does.
  const facets = [...text.matchAll(/https?:\/\/[^\s]+/g)].map((m) => {
    const start = new TextEncoder().encode(text.slice(0, m.index)).length;
    return {
      index: { byteStart: start, byteEnd: start + new TextEncoder().encode(m[0]).length },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }],
    };
  });
  const res = await send(
    fetcher,
    "POST",
    `${BSKY}/com.atproto.repo.createRecord`,
    {
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: { $type: "app.bsky.feed.post", text, createdAt: new Date(now).toISOString(), ...(facets.length ? { facets } : {}) },
    },
    { Authorization: `Bearer ${session.accessJwt}` },
  );
  if (!res.ok) throw new Error(`Bluesky post ${res.status}`);
  return ((await res.json()) as { uri: string }).uri;
}

// ---------- X (OAuth 1.0a, Web Crypto)

/** RFC 3986 percent-encoding, which OAuth 1.0a requires (encodeURIComponent leaves !'()* alone). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The OAuth 1.0a HMAC-SHA1 signature. Body parameters are signed only for form bodies; X's v2 JSON
 * body is not part of the base string.
 */
export async function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): Promise<string> {
  const normalized = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(normalized)].join("&");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  let binary = "";
  for (const b of sig) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function postToX(creds: Extract<Credentials, { platform: "x" }>, text: string, fetcher: Fetch, now: number): Promise<string> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(now / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = await oauthSignature("POST", X_TWEETS, oauth, creds.apiSecret, creds.accessSecret);
  const header = `OAuth ${Object.entries(oauth)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
  const res = await send(fetcher, "POST", X_TWEETS, { text }, { Authorization: header });
  if (!res.ok) throw new Error(`X post ${res.status}`);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** The only exported way to post: an original post, text only. There is no reply parameter to pass. */
export async function postOriginal(creds: Credentials, text: string, fetcher: Fetch = fetch, now = Date.now()): Promise<string> {
  return creds.platform === "bluesky" ? postToBluesky(creds, text, fetcher, now) : postToX(creds, text, fetcher, now);
}

/** X's price per post since February 2026 (design section 5), in mills: $0.015, or $0.20 with a link. */
export function xCostMills(text: string): number {
  return /https?:\/\//.test(text) ? 200 : 15;
}

/** Credentials from secrets named for the account key: SOCIAL_<KEY>_..., dashes as underscores. */
export function credentialsFor(env: Env, account: { key: string; platform: Platform; handle: string }): Credentials | { missing: string[] } {
  const prefix = `SOCIAL_${account.key.toUpperCase().replace(/-/g, "_")}_`;
  const get = (name: string) => (env as unknown as Record<string, string | undefined>)[`${prefix}${name}`]?.trim() || "";
  if (account.platform === "bluesky") {
    const appPassword = get("BLUESKY_APP_PASSWORD");
    return appPassword ? { platform: "bluesky", handle: account.handle, appPassword } : { missing: [`${prefix}BLUESKY_APP_PASSWORD`] };
  }
  const names = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
  const missing = names.filter((n) => !get(n)).map((n) => `${prefix}${n}`);
  if (missing.length) return { missing };
  return { platform: "x", apiKey: get("X_API_KEY"), apiSecret: get("X_API_SECRET"), accessToken: get("X_ACCESS_TOKEN"), accessSecret: get("X_ACCESS_SECRET") };
}
