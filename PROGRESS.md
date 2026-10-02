# Progress: Carrel onto Capsomer v0.3.0

Branch: design/capsomer. Read this first if resumed. Remove this file before the final merge.

## Before starting (recorded)

- Open pull requests on DrDustinEdwards/carrel: none.
- Branches other than main (not touched): carrel-mcp-domain, manuscript-importer, mcp-followups, refresh-cap-paid, stage-2-editor, stage-4-books, stage-5-mcp, stage-6-google, stage-9-social. Conflicts are computed at the end with `git merge-tree`.
- Baseline on main: typecheck clean, 304 tests pass, check:mcp-roles passes. check:conformance started its two wrangler dev servers on the same inspector port and one died with "address already in use"; each now gets its own (`--inspector-port`).

## Decisions

- The CI workflow pushed without trouble, so no ci/github branch is needed.
- Editor: build on Capsomer's markdown editor. "From library" is not on its toolbar, so Carrel keeps its own button and dialog beside the editor and inserts through CodeMirror's public `EditorView.findFromDOM` (one copy of CodeMirror is required anyway).
- Media screen: Capsomer's MediaInspector edits alt, title, caption, tags and bins files; the site API has none of those and Carrel's only write is a permanent delete, so the inspector is not used (see PR).
- Settings in the top bar: Carrel has no settings screen and may not add one. People (Owner only) is the nearest, so the top bar's Settings link goes there for the Owner.

## Done

- CI workflow (.github/workflows/ci.yml), pushed to the branch without trouble.
- Capsomer v0.3.0 installed (npm ls: one copy of every @codemirror and @lezer package), tokens and layers imported, Carrel's paper palette and old CSS deleted, fonts self-hosted (a font under 4 KB was being inlined as a data: URI, which font-src refuses: fonts are never inlined now).
- Shell frame (app/components/frame.tsx, routes/frame.tsx layout), PageHead, ProjectTabs.
- Screens: home, project posts, new post, flags, media, people, manuscripts, social, book, chapter, new book, post editor, book file editor, AI draft, unpublish.
- Editor on Capsomer's markdown editor; "Insert from library" kept in Carrel (app/components/media/library-insert.tsx).
- Screen harness (test/harness, vite.harness.config.ts, scripts/lib/harness.mjs) and npm run check:a11y: 38 screens plus 13 action states (dialogs, palette, slash menu, split, publish gate, Undo), both themes, desktop and phone, no violations.
- Fixed on the way: the preview iframe used a relative address that resolved to the wrong route.

## Next

- Final gates, PR text, conflicts with the older branches, merge.

## Decisions to report

- Flags screen: Capsomer's FlagList always offers Resolve and Reopen (the site API has neither), so the screen uses RowList and Status; same reasoning for the editor's flags.
- Media tiles are written to Capsomer's tile markup without its selection checkbox (no bulk actions exist) and without its "Unattached" word (the list does not know where a file is used; saying so would be a guess).
- Publish gate: open flags are advisory checks (flags never decide); Save, Schedule, Revert (scheduled) and Discard stay Carrel buttons; scheduled is a hold.
- Confirm dialogs added where an action is permanent: discard draft, import from Docs, use an AI draft, dismiss a flag, reject a post, delete media. Undo only for Disable (Enable) and Unpublish (republish).
