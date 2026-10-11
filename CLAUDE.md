# CLAUDE.md - carrel

Carrel is Dustin's private writing hub at https://carrel.dustinedwards.info, behind Cloudflare Access: it edits and publishes each site's content through the shared site API, manages the books, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts and other long-form writing live in the private repo DrDustinEdwards/writing.

## Rules that come first

- The portfolio rules are in Capsid: `capsid/conventions.md` (Capsid's brief delivers it to this namespace). Read it with this file and `carrel/core.md`. Where they disagree, conventions wins.
- The design is `carrel/design.md` in Capsid (approved 2026-09-26). The look is Capsomer.
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel.
- Routine-started sessions use the cloud-driver key, which reads and writes every namespace (capsid/docs/routines.md). Carrel's work reaches this repo, DrDustinEdwards/writing and DrDustinEdwards/site-api (site-api's routes change here when Carrel needs one). To reuse the site's editor code, read dustinedwards-info through Capsid's repo tools (`capsid_read_repo`), not a local clone.
- Never commit `.mcp.json` (it carries the driver key) or `.claude/settings.local.json`; both are gitignored.

## Commands

- `npm run typecheck` (wrangler types, typegen, tsc -b) and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run check:bloat`: a warn-only report (Knip, jscpd, JS and CSS gzip per route) against `docs/bloat-baseline.json`; it always exits 0. Knip and jscpd run through npx at exact versions, set up in `knip.json` and `.jscpd.json`.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local` and `db:migrate:remote`: D1 migrations.

## Deploys

A merge to main deploys itself, through devkit's shared deploy, verify and rollback workflow (`worker-deploy.yml`, pinned in the `deploy` job of `.github/workflows/ci.yml` to the full sha of devkit v0.6.0). It runs after `check` and `gates` pass, on pushes to main only. Its `deploy` job runs `scripts/deploy.mjs --prepare` first: render `wrangler.jsonc` from the example and the repository variables `CARREL_D1_DATABASE_ID`, `CARREL_KV_OAUTH_ID` and `CARREL_ALERT_EMAIL`, check the ids against the names `carrel` and `carrel-oauth`, build, apply remote D1 migrations, confirm none is pending; any failed step stops the run before the deploy. It then deploys with `DEPLOY_SHA` set to the commit. Its `live gate` job polls the AI door's `/health` (the one host outside Access) until it names that commit, runs `scripts/verify-live.mjs`, and rolls the deploy back on a refusal. A rollback never undoes a migration. `scripts/check-deploy.mjs` and `scripts/check-verify-live.mjs` (part of `npm test`) pin the order and the verify; `test/deploy-workflow.test.ts` pins the call. Setup is in `docs/auto-deploy.md`.

`npm run deploy` (build, then wrangler deploy, from your own `wrangler.jsonc`) still works for a manual deploy. It does not run migrations: run `npm run db:migrate:remote` first.

## Backups

A nightly cron (`17 3 * * *`, run on its own) dumps D1 into the R2 bucket `carrel-backups` (binding `BACKUPS`) under `backups/json/`, with d1-dump's retention (14 daily, 8 weekly, 6 monthly). `app/lib/backup.server.ts` dumps without the completion marker, runs `app/lib/backup-checks.ts` (not empty, no credential table, `authorship` and `ai_drafts` present), writes the marker, then prunes. `google_tokens` and `google_oauth_states` are left out. The health check `backup` fails when the newest complete dump is over 26 hours old, and `GET /health` (behind Access) returns `backup.last_ok` and `backup.age_hours`. `test/backup.test.ts` plants each failure. Restore drill: download the newest run, then `npx d1-dump drill --dir <dir> --backend sqlite`.
