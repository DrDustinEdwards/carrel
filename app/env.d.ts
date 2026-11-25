// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them. Declared on both the global Env and
// Cloudflare.Env, because the generated global does not extend the other. Only Carrel's own: the rest are
// site-runtime's SiteSecrets.
type SiteSecrets = import("@dustinedwards/site-runtime/worker").SiteSecrets;

interface CarrelSecrets extends SiteSecrets {
  /** dustinedwards.info's Carrel key, the same value the site holds. Absent until the site is connected. */
  SITE_DUSTINEDWARDS_KEY?: string;
  SITE_GERMOMICS_KEY?: string;
  SITE_FOXHOUND_KEY?: string;
  SITE_FOXING_KEY?: string;
  SITE_TXASM_KEY?: string;
  SITE_JULIEEDWARDS_KEY?: string;
  SITE_BSW_KEY?: string;
  /** The GitHub App `carrel-writer`, installed on DrDustinEdwards/writing only; the key is the .pem as downloaded. Absent until it exists: books then open read-only from the index. */
  NOVELS_APP_ID?: string;
  NOVELS_APP_PRIVATE_KEY?: string;
  /** The AI door's upstream login, the Access for SaaS (OIDC) application's client id and secret. /authorize answers 503 until both are set. */
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  /** Grants and tokens for the AI door's OAuth provider (@cloudflare/workers-oauth-provider); declared here too so an older wrangler.jsonc still types. */
  OAUTH_KV: KVNamespace;
  /** The service account's JSON key file, whole: it reads the manuscripts folder's metadata and Search Console, and nothing else. */
  GOOGLE_SA_KEY?: string;
  /** The Web OAuth client for Dustin's drive.file grant (Send to Docs, Import). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** 32 random bytes, base64 or hex, that seal the drive.file refresh token in D1 (site-runtime secret-box). */
  GOOGLE_TOKEN_KEY?: string;
  /** The Docs panel add-on's OAuth client id, the audience of the ID tokens it sends (app/lib/google/panel.server.ts). Not a secret. */
  GOOGLE_PANEL_CLIENT_ID?: string;
  /** The Claude Code routine that drafts brand posts: its API trigger's /fire URL and a token that can fire that one routine and read nothing. */
  SOCIAL_ROUTINE_URL?: string;
  SOCIAL_ROUTINE_TOKEN?: string;
  /**
   * Named agent keys for agents that cannot complete the AI door's OAuth sign-in: one secret per agent, and the secret's NAME
   * is the agent (AGENT_KEY_GROK is "grok"). The key grants nothing; the role is the person row "agent:grok" in People.
   * Any AGENT_KEY_<NAME> is read; only the first is declared here.
   */
  AGENT_KEY_GROK?: string;
  /** Carrel's own Capsid agent key, the bearer for the inbox report. Inert until set. */
  CAPSID_AGENT_KEY?: string;
}

interface Env extends CarrelSecrets {}

declare namespace Cloudflare {
  interface Env extends CarrelSecrets {}
}
