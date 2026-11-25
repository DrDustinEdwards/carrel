# CLAUDE.md - carrel

Carrel is Dustin's private writing hub. Its signed-in app is Desk, at https://desk.dustinedwards.info behind Cloudflare Access; https://carrel.dustinedwards.info is the public page (`www/`, its own Worker, docs/public-site.md). Desk edits and publishes each site's content through the shared site API, manages the books, indexes manuscripts read-only from Google Drive, and keeps an authorship record of every change. This repo holds the app code only; no writing is stored here. Manuscripts and other long-form writing live in the private repo DrDustinEdwards/writing.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it, and report red before and green after. Keep the minimal set: a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives. Remove a test that pins design, repeats coverage or never caught a mistake, unless it guards a harm that cannot be undone.
- **UI copy.** Let the layout explain: no eyebrows, restating subtitles, "this page lets you" intros, hints a label already gives or empty-state essays. Labels, accessible names, errors, one-way warnings and legal text stay (Dustin, 2026-11-18; capsid/conventions.md).
- **Shared code.** Before writing anything another site might have, check https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md. Change shared code in place and delete what the change replaces in the same PR.
- **Browser support.** devkit's docs/browser-support.md: Baseline Widely available freely, Newly available with a small fallback, Limited only feature-detected, no polyfills.
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.
- **Deploys.** A merge to the default branch deploys; never deploy from a session.
- **D1.** Never hand-run production DDL; CI applies additive migrations and refuses the rest. Back up and restore with d1-dump, never `wrangler d1 export` (it fails on FTS5 tables).
- **Site copy and AI.** Copy describes only what the current build does. An AI provider key stays on the server, never in a client.

## Rules for this repo

- The look is Capsomer. No paid editor platform, and no outside service holds documents; references stay in Paperpile (Dustin, 2026-10-10).
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked; drafting continues from his own passages. Only the Owner publishes or sends anything outside Carrel, except that an Author publishes, schedules and unpublishes the posts they wrote on the projects they are granted (`publish_own`, app/lib/roles.ts).

## Commands

- `npm run typecheck`, then `npm run lint` (it reads the generated types), and `npm test`: the quick local checks.
- `npm run check:a11y`, `npm run check:conformance`, `npm run check:mcp-roles`, `npm run check:plants`: the gates for accessibility, the MCP door, the AI roles and the planted-failure proofs.
- `npm run check:bloat`: devkit-no-bloat (Knip, jscpd) against `.no-bloat.json`, then route weight against `.route-weight.json`.
- `npm run harness`: the app against a fake site, for working without the real one.
- `npm run db:migrate:local`: local D1 migrations.
