# Auto-deploy on merge

Carrel deploys itself when a pull request merges to main. The mechanism is a `deploy` job in GitHub Actions, not Cloudflare Workers Builds.

## Why a GitHub Actions job and not Workers Builds

- Workers Builds cannot be gated on GitHub CI. It starts a build on every push to the production branch by itself; Cloudflare's docs describe GitHub check runs it reports back, but no setting that makes it wait for GitHub Actions or other checks. The only gate would be a branch protection rule on main (which a merge already satisfies), or running the tests again inside the Cloudflare build command. https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/ and https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Workers Builds' automatic API token has no D1 permission (Workers Scripts, KV, R2 and Workers Routes edit only), so it needs a custom token anyway, held in Cloudflare instead of GitHub.
- A GitHub job uses `needs:` to run only after `check` and `gates` pass, on main only, and a failed migration step fails the job visibly in the same place as the tests. Cloudflare's own GitHub Actions page documents this setup with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- Cost: one scoped API token stored as a GitHub secret.

## What the job runs

The `deploy` job in `.github/workflows/ci.yml` calls devkit's shared workflow, `worker-deploy.yml` at a pinned devkit sha. Its inputs, secrets and limits are in devkit's README, "The shared deploy". It has two jobs.

`deploy`, with Carrel's guard first. The `pre-deploy` input runs `scripts/deploy.mjs --prepare`, and every step stops the run on a nonzero exit:

1. Check `CARREL_D1_DATABASE_ID`, `CARREL_KV_OAUTH_ID` and `CARREL_ALERT_EMAIL` are set and not placeholders.
2. Render `wrangler.jsonc` from `wrangler.jsonc.example` (real ids and email, both custom-domain routes on). It refuses to overwrite a `wrangler.jsonc` that is not the placeholder copy.
3. Check the ids against the account: the D1 database named `carrel` and the KV namespace titled `carrel-oauth` must have exactly those ids.
4. Build.
5. `wrangler d1 migrations apply DB --remote`.
6. `wrangler d1 migrations list DB --remote` must report `No migrations to apply`.

Then devkit's workflow runs `wrangler deploy --name carrel --var DEPLOY_SHA:<commit>` on the build step 4 left, with its own pinned wrangler.

`live gate`. It polls `https://carrel-mcp.dustinedwards.info/health`, the AI door's liveness, until its `sha` is the commit just deployed. The browser host's `/health` is behind Access, so CI could never read it. Then it runs `scripts/verify-live.mjs`, which needs no secret and no install:

- the AI door's `/health` names the commit;
- its OAuth metadata is served with Carrel's issuer;
- its `/mcp` refuses a request with no token;
- an unknown path there is a 404;
- the browser host answers someone who has not signed in with Access (a redirect to the team's sign-in, or 401 or 403), never with Carrel.

Exit 1 is a refusal, and the step "Roll back the deploy this run shipped" puts the previous version back. Exit 3 is "could not run" and rolls nothing back. A rollback swaps code and bindings only: it is refused when D1 or KV resources changed between the versions, and it never undoes a migration. Data recovery is D1 Time Travel, by hand.

`scripts/check-deploy.mjs` and `scripts/check-verify-live.mjs` (run by `npm test`) drive both scripts against stubs and pin each refusal and the order.

Secrets set with `wrangler secret put` live in the Worker and survive deploys.

## Settings

GitHub repository, Settings, Secrets and variables, Actions:

- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. devkit's workflow takes these two secrets and no others.
- Variables: `CARREL_D1_DATABASE_ID` (07402005-1960-4bf3-9532-5e28aebacaa5), `CARREL_KV_OAUTH_ID` (16485b7142b949a1bb9e242da6b9177f), and `CARREL_ALERT_EMAIL`, the address health alerts go to. It is a variable, not a secret, because the workflow passes the guard no third secret.
- The R2 bucket `carrel-backups` (binding `BACKUPS`) must exist before the first deploy that carries it: `npx wrangler r2 bucket create carrel-backups`. A missing bucket fails `wrangler deploy`, after the migrations.

Token (Cloudflare dashboard, Manage Account, Account API tokens): the "Edit Cloudflare Workers" template plus Account, D1, Edit, scoped to this one account and the dustinedwards.info zone. The KV list in step 3 is covered by the template's Workers KV Storage permission, and `wrangler rollback` by Workers Scripts, Edit.

`npm run deploy:ci` still runs `scripts/deploy.mjs` without `--prepare`, which deploys at the end with the repository's own wrangler, for a deploy by hand from a machine that has the variables.
