// The deployed commit, from the DEPLOY_SHA var the CI deploy sets (devkit's worker-deploy.yml, its
// `sha-var` input). The deploy's live gate polls the AI door's /health until it reports the commit it
// shipped. Read loosely: DEPLOY_SHA is not in wrangler.jsonc, so a manual deploy has none and reports
// "unknown", which the live gate reads as not yet this run's commit.

export function deployedSha(env: Env): string {
  const sha = (env as { DEPLOY_SHA?: string }).DEPLOY_SHA?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : "unknown";
}
