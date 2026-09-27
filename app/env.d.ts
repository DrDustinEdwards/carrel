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
}

interface Env extends CarrelSecrets {}

declare namespace Cloudflare {
  interface Env extends CarrelSecrets {}
}
