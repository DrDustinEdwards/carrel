# CLAUDE.md - carrel

Carrel is Dustin's private writing hub at https://carrel.dustinedwards.info, behind Cloudflare Access: it edits and publishes each site's content through the shared site API, manages the novels, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts live in the private repo DrDustinEdwards/novels.

## Rules that come first

- The portfolio rules are in Capsid: `capsid/conventions.md` (Capsid's brief delivers it to this namespace). Read it with this file and `carrel/core.md`. Where they disagree, conventions wins.
- The design is `carrel/design.md` in Capsid (approved 2026-09-26). The look is Capsomer.
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel.
- The carrel driver key reaches this repo, DrDustinEdwards/novels and DrDustinEdwards/site-api (site-api's routes change here when Carrel needs one). It cannot read the dustinedwards namespace: to reuse the site's editor code, read the local clone at `C:\Users\email\dev\dustinedwards-info`.
- Never commit `.mcp.json` (it carries the driver key) or `.claude/settings.local.json`; both are gitignored.

## Commands

- `npm run typecheck` (wrangler types, typegen, tsc -b) and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local` and `db:migrate:remote`: D1 migrations.

## Deploys

A merge to main deploys itself: the `deploy` job in `.github/workflows/ci.yml` runs after `check` and `gates` pass, on pushes to main only, and calls `npm run deploy:ci` (`scripts/deploy.mjs`). It renders `wrangler.jsonc` from the example and the variables `CARREL_D1_DATABASE_ID`, `CARREL_KV_OAUTH_ID` and `CARREL_ALERT_EMAIL`, checks the ids against the names `carrel` and `carrel-oauth`, builds, applies remote D1 migrations, confirms none is pending, then deploys. Any failed step stops the run before the deploy. `scripts/check-deploy.mjs` (part of `npm test`) pins that order. Setup and the job text are in `docs/auto-deploy.md`.

`npm run deploy` (build, then wrangler deploy, from your own `wrangler.jsonc`) still works for a manual deploy. It does not run migrations: run `npm run db:migrate:remote` first.
