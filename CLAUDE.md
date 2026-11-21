# CLAUDE.md - carrel

Carrel is Dustin's private writing hub. Its signed-in app is Desk, at https://desk.dustinedwards.info behind Cloudflare Access; https://carrel.dustinedwards.info is the public page (`www/`, its own Worker, docs/public-site.md). Desk edits and publishes each site's content through the shared site API, manages the books, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts and other long-form writing live in the private repo DrDustinEdwards/writing.

## Rules every repo shares

- **Tests.** Keep the minimal set (a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- **UI copy.** Let the layout explain. No eyebrows, restating subtitles, "this page lets you" intros, descriptions under obvious buttons, hints a label already gives, repeated captions or empty-state essays; labels, accessible names, errors, one-way warnings and legal text stay (Dustin, 2026-11-18; Capsid capsid/conventions.md).
- **Shared code.** Before writing anything another site might have, read https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md (CI's shared-code check fails on a copy). Change shared code in place and delete what a change replaces in the same PR.
- **Browser support.** devkit's docs/browser-support.md (Baseline Widely available freely; Newly available with a small fallback; Limited only feature-detected; no polyfills).
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.
- **Reproduce first.** A report that something is broken names a cause; reproduce the failure before fixing it, and report red before and green after.
- **Deploys.** A merge to the default branch deploys (CI's deploy job); never deploy from a session.
- **D1.** Migrations are additive: CI applies the ones that only add and refuses a drop, rename or row delete for a hand run; never hand-run production DDL. `wrangler d1 export` fails on FTS5 tables, so back up and restore with d1-dump (its README); never export an `*_fts` table. Checking backups, backing up now and running a scheduled job now are Capsid Admin's, for every site (`/api/operator`, site-runtime `./operator`).
- **Site copy and AI.** Copy describes only what the current build does. An AI provider key stays on the server, never in a client.

## Rules for this repo

- Current state is `carrel/core.md` in Capsid. The look is Capsomer.
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel, except that an Author publishes, schedules and unpublishes the posts they wrote on the projects they are granted (`publish_own`, app/lib/roles.ts).

## Commands

- `npm run typecheck` (wrangler types, typegen, tsc -b), `npm run lint` (Oxlint, the shared config in `oxlint.config.ts`; after typecheck, which makes the types it reads) and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run check:bloat`: Knip and jscpd against `.no-bloat.json` (`devkit-no-bloat`; a count above its baseline fails), then JS and CSS gzip per route against `.route-weight.json` (devkit-route-weight, warn-only). Knip and jscpd run through npx at the exact versions in `.no-bloat.json`, set up in `knip.json` and `.jscpd.json`.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local`: local D1 migrations.
