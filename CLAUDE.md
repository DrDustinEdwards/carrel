# CLAUDE.md - carrel

Carrel is Dustin's private writing hub at https://carrel.dustinedwards.info, behind Cloudflare Access: it edits and publishes each site's content through the shared site API, manages the books, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts and other long-form writing live in the private repo DrDustinEdwards/writing.

## Rules that come first

- The portfolio rules are in Capsid: `capsid/conventions.md` (Capsid's brief delivers it to this namespace). Read it with this file and `carrel/core.md`. Where they disagree, conventions wins.
- The design is `carrel/design.md` in Capsid (approved 2026-09-26). The look is Capsomer.
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel.

## Commands

- `npm run typecheck` (wrangler types, typegen, tsc -b) and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run check:bloat`: a warn-only report (Knip, jscpd, JS and CSS gzip per route) against `docs/bloat-baseline.json`; it always exits 0. Knip and jscpd run through npx at exact versions, set up in `knip.json` and `.jscpd.json`.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local` and `db:migrate:remote`: D1 migrations.

## Deploys

`npm run deploy` (build, then wrangler deploy, from your own `wrangler.jsonc`) still works for a manual deploy. It does not run migrations: run `npm run db:migrate:remote` first.
