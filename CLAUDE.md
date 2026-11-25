# CLAUDE.md - carrel

Carrel, Dustin's private writing hub: Desk (https://desk.dustinedwards.info, behind Access) edits and publishes each site's content through site-api. App code only; no writing is stored here.

## Rules every repo shares

- **Tests.** Reproduce a reported failure first: red before, green after. Keep the set minimal; delete a test that pins design or repeats coverage.
- **UI copy.** Let the layout explain: no eyebrows, restating subtitles, intros or hints a label already gives (Dustin, 2026-11-18).
- **Shared code.** Check devkit's [SHARED.md](https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md) before writing anything another repo might have. Change shared code in place and delete what it replaces.
- **Secrets.** Never commit or print a key or token. AI provider keys stay on the server.
- **Production.** Never deploy, tag, release or run production DDL from a session; a merge deploys. Back up and restore D1 only with d1-dump.
- **Copy.** Site copy says only what the current build does.

## Rules for this repo

- No paid editor platform, and no outside service holds documents; references stay in Paperpile (Dustin, 2026-10-10).
- Checks and reviewers flag; they never decide. AI never rewrites Dustin's prose unasked. Only the Owner publishes or sends anything outside Carrel, except an Author's own posts on granted projects (`publish_own`, app/lib/roles.ts).

## Commands

- `npm run typecheck`, then `npm run lint`, then `npm test`. `npm run harness` runs the app against a fake site.
