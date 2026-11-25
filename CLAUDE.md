# CLAUDE.md - carrel

Carrel, Dustin's private writing hub: Desk (https://desk.dustinedwards.info, behind Access) edits and publishes each site's content through site-api. App code only; no writing is stored here.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it: red before, green after.
- **UI copy.** No eyebrows, restating subtitles, intros or hints a label already gives (Dustin, 2026-11-18).
- **Shared code.** Check devkit's [SHARED.md](https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md) before writing anything another repo might have; change it in place.
- **Secrets.** Never commit or print a key or token. AI provider keys stay on the server.
- **Production.** Never deploy, tag, release or run production DDL from a session; a merge deploys. Back up and restore D1 only with d1-dump.

## Rules for this repo

- No paid editor platform, and no outside service holds documents; references stay in Paperpile (Dustin, 2026-10-10).
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked. Only the Owner publishes or sends anything outside Carrel, except an Author's own posts on granted projects (`publish_own`, app/lib/roles.ts).

## Commands

- `npm run typecheck`, then `npm run lint`, then `npm test`. `npm run harness` runs the app against a fake site.
