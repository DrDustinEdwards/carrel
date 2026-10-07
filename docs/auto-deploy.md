# Auto-deploy on merge

Decision (2026-10-07): Carrel deploys itself when a pull request merges to main. The mechanism is a `deploy` job in GitHub Actions (option b below), not Cloudflare Workers Builds.

## Why a GitHub Actions job and not Workers Builds

- Workers Builds cannot be gated on GitHub CI. It starts a build on every push to the production branch by itself; Cloudflare's docs describe GitHub check runs it reports back, but no setting that makes it wait for GitHub Actions or other checks. The only gate would be a branch protection rule on main (which a merge already satisfies), or running the tests again inside the Cloudflare build command. https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/ and https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Workers Builds' automatic API token has no D1 permission (Workers Scripts, KV, R2 and Workers Routes edit only), so it needs a custom token anyway, held in Cloudflare instead of GitHub.
- A GitHub job uses `needs:` to run only after `check` and `gates` pass, on main only, and a failed migration step fails the job visibly in the same place as the tests. Cloudflare's own GitHub Actions page documents this setup with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- Cost: one scoped API token stored as a GitHub secret.

## What the job runs

`npm run deploy:ci` is `scripts/deploy.mjs`. Every step stops the run on a nonzero exit:

1. Check `CARREL_D1_DATABASE_ID`, `CARREL_KV_OAUTH_ID` and `CARREL_ALERT_EMAIL` are set and not placeholders.
2. Render `wrangler.jsonc` from `wrangler.jsonc.example` (real ids and email, both custom-domain routes on). It refuses to overwrite a `wrangler.jsonc` that is not the placeholder copy.
3. Check the ids against the account: the D1 database named `carrel` and the KV namespace titled `carrel-oauth` must have exactly those ids.
4. Build.
5. `wrangler d1 migrations apply DB --remote`.
6. `wrangler d1 migrations list DB --remote` must report `No migrations to apply`.
7. `wrangler deploy`.

Secrets set with `wrangler secret put` live in the Worker and survive deploys. `scripts/check-deploy.mjs` (run by `npm test`) drives the script against stubs and pins each refusal and the order.

## Settings

GitHub repository, Settings, Secrets and variables, Actions:

- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CARREL_ALERT_EMAIL`.
- Variables: `CARREL_D1_DATABASE_ID` (07402005-1960-4bf3-9532-5e28aebacaa5), `CARREL_KV_OAUTH_ID` (16485b7142b949a1bb9e242da6b9177f).

Token (Cloudflare dashboard, Manage Account, Account API tokens): the "Edit Cloudflare Workers" template plus Account, D1, Edit, scoped to this one account and the dustinedwards.info zone. The KV list in step 3 is covered by the template's Workers KV Storage permission.

## The workflow change

In `.github/workflows/ci.yml`, replace the `concurrency` block so a second push to main cannot cancel a deploy halfway:

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

and add this job after `gates`:

```yaml
  deploy:
    needs: [check, gates]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: npm
      - run: npm ci
      - run: npm run deploy:ci
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CARREL_ALERT_EMAIL: ${{ secrets.CARREL_ALERT_EMAIL }}
          CARREL_D1_DATABASE_ID: ${{ vars.CARREL_D1_DATABASE_ID }}
          CARREL_KV_OAUTH_ID: ${{ vars.CARREL_KV_OAUTH_ID }}
```

`npm test` already runs `check:deploy`, so `check` covers the script without another step.
