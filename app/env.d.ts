// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them. Declared here instead, on
// both the global Env and Cloudflare.Env, because the generated global does not extend the other.
interface CarrelSecrets {
  /** The AUD tag of the Worker's Access application. Set with `wrangler secret put ACCESS_AUD`. */
  ACCESS_AUD: string;
  /**
   * dustinedwards.info's Carrel key, the same value the site holds. Absent until the site is
   * connected (setup step 10). Set with `Get-Clipboard | npx wrangler secret put SITE_DUSTINEDWARDS_KEY`.
   */
  SITE_DUSTINEDWARDS_KEY?: string;
  /**
   * The GitHub App `carrel-writer`, installed on DrDustinEdwards/novels only (setup step 8). Absent
   * until it exists; books then open read-only from Carrel's index. The key is the .pem GitHub
   * downloads, as it is: `Get-Content <file>.pem -Raw | npx wrangler secret put NOVELS_APP_PRIVATE_KEY`.
   */
  NOVELS_APP_ID?: string;
  NOVELS_APP_PRIVATE_KEY?: string;
  /**
   * The AUD tag of the MCP Access application, the one with Managed OAuth on (the AI door). Absent
   * until stage 5's setup; /mcp refuses every request until it is set. Set with
   * `Get-Clipboard | npx wrangler secret put ACCESS_MCP_AUD`.
   */
  ACCESS_MCP_AUD?: string;
  /**
   * The service account's JSON key file, whole (setup step 9): it reads the manuscripts folder's
   * metadata and Search Console, and nothing else. `Get-Content <key>.json -Raw | npx wrangler secret put GOOGLE_SA_KEY`.
   */
  GOOGLE_SA_KEY?: string;
  /** The Web OAuth client for Dustin's drive.file grant (Send to Docs, Import). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** 32 random bytes, base64, that encrypt the drive.file refresh token in D1. */
  GOOGLE_TOKEN_KEY?: string;
  /**
   * The Claude Code routine that drafts brand posts (design decision 5): its API trigger's /fire URL
   * and the token generated for it, which can fire that one routine and read nothing.
   */
  SOCIAL_ROUTINE_URL?: string;
  SOCIAL_ROUTINE_TOKEN?: string;
}

interface Env extends CarrelSecrets {}

declare namespace Cloudflare {
  interface Env extends CarrelSecrets {}
}
