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

- CI workflow (.github/workflows/ci.yml).

## Next

- Install capsomer, fonts; shell; harness; screens in order: home, project, project.new, project.flags, media, people, manuscripts, social, books (book, chapter, new), editor, book file, ai-draft, unpublish.
