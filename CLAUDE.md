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

`npm run deploy` (build, then wrangler deploy) is the only deploy; CI (`.github/workflows/ci.yml`) runs the tests and deploys nothing. A merge does not deploy.
