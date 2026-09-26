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
}

interface Env extends CarrelSecrets {}

declare namespace Cloudflare {
  interface Env extends CarrelSecrets {}
}
