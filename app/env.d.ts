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
  /** germomics's Carrel key, the same value the site holds as CARREL_SITE_KEY. `Get-Clipboard | npx wrangler secret put SITE_GERMOMICS_KEY`. */
  SITE_GERMOMICS_KEY?: string;
  /**
   * The GitHub App `carrel-writer`, installed on DrDustinEdwards/writing only (setup step 8). Absent
   * until it exists; books then open read-only from Carrel's index. The key is the .pem GitHub
   * downloads, as it is: `Get-Content <file>.pem -Raw | npx wrangler secret put NOVELS_APP_PRIVATE_KEY`.
   */
  NOVELS_APP_ID?: string;
  NOVELS_APP_PRIVATE_KEY?: string;
  /**
   * The AI door's upstream login (design decision 7, corrected): the Cloudflare Access for SaaS (OIDC)
   * application's client id and secret. Absent until its setup; the door's /authorize answers 503
   * until both are set. `Get-Clipboard | npx wrangler secret put ACCESS_SAAS_CLIENT_ID`, then the same
   * for ACCESS_SAAS_CLIENT_SECRET.
   */
  ACCESS_SAAS_CLIENT_ID?: string;
  ACCESS_SAAS_CLIENT_SECRET?: string;
  /**
   * Grants and tokens for the AI door's OAuth provider (@cloudflare/workers-oauth-provider). A KV
   * binding in wrangler.jsonc, declared here too because a config from before the AI door lacks it.
   */
  OAUTH_KV: KVNamespace;
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
  /**
   * Named agent keys for the AI door, for agents that cannot complete its OAuth sign-in: one secret
   * per agent, and the secret's NAME is the agent (AGENT_KEY_GROK is "grok"). The key says which agent
   * is knocking and grants nothing; the agent's role is its person row "agent:grok" in People. Inert
   * until a secret exists. Any AGENT_KEY_<NAME> is read, so this declares only the first one:
   * `Get-Content <key file> -Raw | npx wrangler secret put AGENT_KEY_GROK`.
   */
  AGENT_KEY_GROK?: string;
  /**
   * Carrel's own Capsid agent key (the agents tool, carrel namespace, write grant): the bearer for
   * the inbox report that badges Carrel in the AdminShell. Inert until set:
   * `Get-Clipboard | npx wrangler secret put CAPSID_AGENT_KEY`.
   */
  CAPSID_AGENT_KEY?: string;
}

interface Env extends CarrelSecrets {}

declare namespace Cloudflare {
  interface Env extends CarrelSecrets {}
}
