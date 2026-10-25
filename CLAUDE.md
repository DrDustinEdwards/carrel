# CLAUDE.md - carrel

Carrel is Dustin's private writing hub at https://carrel.dustinedwards.info, behind Cloudflare Access: it edits and publishes each site's content through the shared site API, manages the books, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts and other long-form writing live in the private repo DrDustinEdwards/writing. Before writing anything another site might have, read what the family shares: https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md (CI's family check fails on a copy).

## Rules that come first

- Current state is `carrel/core.md` in Capsid. The look is Capsomer.
- Tests: keep the minimal set (a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel.

## Commands

- `npm run typecheck` (wrangler types, typegen, tsc -b) and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run check:bloat`: a warn-only report (`devkit-no-bloat --warn-only`: Knip and jscpd against `.no-bloat.json`; JS and CSS gzip per route against `.route-weight.json` through devkit-route-weight); it always exits 0. Knip and jscpd run through npx at the exact versions in `.no-bloat.json`, set up in `knip.json` and `.jscpd.json`.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local` and `db:migrate:remote`: D1 migrations.

## Deploys

`npm run deploy` (build, then wrangler deploy, from your own `wrangler.jsonc`) still works for a manual deploy. It does not run migrations: run `npm run db:migrate:remote` first.
