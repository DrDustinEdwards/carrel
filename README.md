# carrel

Carrel: a private writing hub for articles across sites, books and manuscripts (app code only; no writing is stored here).

The design is `carrel/design.md` in Capsid.

- **Stage 1, the private shell:** a React Router Worker that admits a request only when Cloudflare Access has signed it and its email belongs to an active person in Carrel. It adds per-project roles and a health check that emails on a change of state.
- **Stage 2, dustinedwards.info through [site-api](https://github.com/DrDustinEdwards/site-api) `v0.1.0`:**
  - the one view of the site's posts, with status and kind filters and FTS5 search;
  - the site's CodeMirror editor in a prose layout, with autosave to D1;
  - the site's own render in a sandboxed preview;
  - saving and publishing, by role;
  - a Content Security Policy on every page.
- **Stage 4, books in the private novels repository:**
  - the book view, chapter view and a file editor for scenes, bible entries and outlines (the same editor, autosave to D1, Save commits to Git with the version it expects to replace);
  - the checks on save: scene headers, continuity and timeline against the bible, world rules, the AI-habits lint and voice;
  - the authorship record, as a Markdown report;
  - export to ePub and Word, and a print page for PDF.
- **Stage 5, AI work through MCP tools in the Worker:** read, search, preview, AI drafts beside yours, flags from checks and reviewers, and publish by instruction for the Owner's own sessions, refused while a flag is open and emailed with an unpublish link.
- **Stage 6, Google:** the manuscripts index and search through a read-only service account, Send to Docs and Import through a `drive.file` grant, and Search Console per page.
- **Stage 9, social (nothing posted until accounts are connected):** a queue that announces pieces that went live, from a draft stored ahead, else a Claude Code routine, else a template, with the AI-habits lint, per-account switches and caps, and no reply code at all.

## Develop

```sh
npm install                  # also creates wrangler.jsonc from the example
npm run db:migrate:local
npm run seed:owner -- you@example.com "Your Name"
npm test                     # Vitest in workerd with local D1
npm run typecheck
npm run build
npm run check:mcp-roles      # no role logic in app/lib/mcp/
npm run check:conformance    # the official MCP conformance suite, against a recorded baseline
npm run check:plants         # each gate above, seen red on a planted violation (several minutes)
npm run check:a11y           # an axe scan (WCAG 2.2 A and AA) of every screen, both themes, desktop and phone
```

GitHub Actions runs all of these on every push and pull request (`.github/workflows/ci.yml`); none needs a secret.

## The look

Carrel's interface is [Capsomer](https://github.com/DrDustinEdwards/capsomer) (`v0.3.0`): its shell (rail, top bar, phone tab bar), tokens, components and fonts, with Carrel's own CSS in `app/app.css` limited to the page frame and the few rules the writing screens need. The fonts (Schibsted Grotesk, Martian Mono, Source Serif 4) are self-hosted from the build; nothing loads from another origin, and `workers/csp.ts` is unchanged. Carrel is private, so Web Analytics is excluded for `carrel.` and `carrel-mcp.` in the Cloudflare dashboard; the CSP is deliberately not loosened for Cloudflare's beacon, and `test/csp.test.ts` pins that. The only components Carrel keeps are `app/components/editor` (the writing surface around Capsomer's markdown editor) and `app/components/media` (image upload and "Insert from library").

`npm run harness` builds and serves the real app on http://127.0.0.1:5199 with the Access gate replaced by a header naming the viewer (`x-harness-viewer`: `dustin@harness.invalid` the Owner, `rosa@harness.invalid` an Editor, `sam@harness.invalid` a Reader) and a fake site, novels repository and Google (`test/harness`). It needs no Cloudflare credentials. `node scripts/screens.mjs <directory>` writes a screenshot of every screen in both themes at desktop and phone widths, for looking at.

Every request without a valid Access token is refused, locally too, so the app answers 403 until it runs behind Access.

The tests never reach the network. Site tests run Carrel's code against site-api's own handler over its in-memory reference adapter (`test/site.ts`).

## Deploy order (Carrel is never public)

1. `npx wrangler d1 create carrel`, put the id in `wrangler.jsonc`, `npm run db:migrate:remote`, `npm run seed:owner -- <email> "<name>" --remote`.
2. `npm run deploy` with no route: `workers_dev` and `preview_urls` are false, so nothing reaches the Worker yet.
3. Turn on Access for the Worker (Workers & Pages, carrel, Access, All traffic) and `Get-Clipboard | npx wrangler secret put ACCESS_AUD`.
4. Uncomment `routes` in `wrangler.jsonc` and deploy again to add `carrel.dustinedwards.info`.

## Connecting a site

A project is a site when its `site` column names an entry in `app/lib/sites.server.ts`. Migration `0002` creates the dustinedwards.info project.

The site's origin is a var (`SITE_DUSTINEDWARDS_ORIGIN`). Its key is a secret, the same value the site holds:

```powershell
Get-Clipboard | npx wrangler secret put SITE_DUSTINEDWARDS_KEY
```

Until the key is set, the site shows as not connected, and the health check reports it as not connected rather than failing. Once it is set:

- the health check runs site-api's conformance suite against the site every 15 minutes and emails on a change of state;
- the same cron refreshes the one view's index.

## Connecting the novels repository

A project is a book when its `book` column names a folder in `DrDustinEdwards/novels` (New book, on the home page, for the Owner). Carrel reaches the repository only through the GitHub App `carrel-writer` (design setup step 8), installed on `novels` alone with contents read and write. Each installation token Carrel asks for is narrowed again to that repository and to contents.

```powershell
Get-Clipboard | npx wrangler secret put NOVELS_APP_ID                        # the App's numeric id
Get-Content <the-downloaded-key>.pem -Raw | npx wrangler secret put NOVELS_APP_PRIVATE_KEY
```

The key goes in as GitHub downloads it (PKCS#1, "BEGIN RSA PRIVATE KEY"); Carrel converts it. Until both are set, books open read-only from Carrel's index, Save explains why it is waiting, and the health check reports `novels` as not connected rather than failing. Once they are set, the health check asks GitHub for a token every 15 minutes.

### The layout Carrel reads

```text
shared/voice/*.md              Dustin's own passages, which the voice check compares with
shared/checks/ai-habits.md     words: [...] added to the AI-habits list, allow: [...] removed, conditions: false
<book>/book.md                 title, author, language for export
<book>/bible/characters/*.md   name, aliases, born, died
<book>/bible/places/*.md       name, aliases
<book>/bible/rules/*.md        name, forbidden: [patterns matched against every scene]
<book>/outline/*.md
<book>/chapters/NN-name/NN-scene.md
<book>/build/                  ignored
```

Each scene opens with its header: `pov`, `date` (2031-04-12, or 2031-04-12 14:30), `location`, `characters`, Dustin's beats `goal`, `conflict`, `outcome`, and `flashback: true` for a scene out of order. The header is a narrow YAML subset (`key: value`, `key: [a, b]`, or one `- item` per line); a line outside it is reported in the editor, never guessed at.

### The checks

They run on every save, on the saved text, and after a refresh that finds changes; Check this text runs them on a draft without saving. They flag and never refuse: a flag never stops a save. An open flag holds export until the text is fixed or the Owner dismisses it, and a dismissal survives later saves of the same words.

| Check | Flags |
|---|---|
| header | a missing header, point of view, date, location or beat; a date that is not a story date |
| continuity | someone present who is not in the bible, dead at the scene's date or not yet born; a location not in the bible |
| timeline | a scene dated before the scene it follows, unless it is marked flashback (a flashback does not move the clock) |
| world-rules | a match for any rule's forbidden patterns; on the rule itself, a pattern that cannot compile |
| ai-habits | a word from the AI-tells list in `capsid/conventions.md` (plus the book's additions); the "not X, it's Y" construction; a paragraph closing on a rule-of-three list |
| voice | a scene of 250 words or more that reads unlike `shared/voice/`: sentence length, function words and punctuation, a Burrows' Delta-style distance |

The voice threshold (`VOICE_THRESHOLD` in `app/lib/novels/voice.ts`) was set on test fixtures that stand in for Dustin's passages; it needs setting again once `shared/voice/` holds his own text. Every check has a planted problem that must be flagged and a clean twin that must not (`test/checks.test.ts`).

## Importing a manuscript from Word

A manuscript that starts as Word files (exported from Google Docs with File, Download, Microsoft Word) is converted once into a book in the novels repository, then reviewed as a pull request there. Nothing is sent anywhere; the importer reads the files and writes Markdown into a local clone.

```powershell
git clone https://github.com/DrDustinEdwards/novels.git C:/dev/novels
git -C C:/dev/novels switch -c import-paluxy-portal
npm run import:docx -- C:/path/to/manuscript-folder --book paluxy-portal --novels C:/dev/novels
```

- A folder's `.docx` files are read in name order, so name them `01-...`, `02-...`. Single files can be listed instead.
- In each file, a **Heading 1** starts a chapter (`chapters/NN-name/`); a file with no Heading 1 is one chapter named after the file. The **Title** paragraph becomes the title in `book.md` (or pass `--title "..."`).
- A paragraph that is only a scene-break mark (`* * *`, `***`, `#`, `~`) starts a new scene (`NN-first-words.md`). Empty paragraphs never do.
- Italics become `*...*`, bold `**...**`. Each scene opens with an empty scene header for you to fill.
- Anything it cannot convert cleanly (tables, images, footnotes, comments, tracked changes, lists, line breaks inside a paragraph, headings below Heading 1, centered text, text before the first chapter) is **flagged, not guessed**: an `<!-- import: ... -->` line where it happened, and a row in `<book>/build/import-report.md`. Remove every marker before exporting.
- It refuses to write into a book that already has `chapters/`.

Then review the result in the clone, commit it, and open a pull request in the novels repository. The importer's tests (`test/import.test.ts`) run on a short test document built from `test/fixtures/import/test-manuscript.mjs`.

## The AI door (MCP)

The AI door is its own hostname, `carrel-mcp.dustinedwards.info` (design decision 7, corrected 2026-09-27). Every request that arrives there is an AI session, and every other hostname is the browser door behind Access; the hostname alone decides, never the email. The pages are never served on the AI host, and `/mcp` on the browser's host is just a page that does not exist.

- **Protocol:** the official MCP SDK v2 (`@modelcontextprotocol/server` 2.0.0) through `agents`, stateless, at `/mcp`. The design-center era is 2026-07-28; 2025-era clients (Claude Code and claude.ai, as last measured) are answered by the shim in `app/lib/mcp/legacy-era.ts`, which carries its own removal condition.
- **Sign-in:** the door is an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider` 1.1.0, exact), CIMD only: clients present a metadata URL as their `client_id`, and there is no registration endpoint. After a consent page, the person signs in with Cloudflare Access for SaaS (OIDC; secrets `ACCESS_SAAS_CLIENT_ID` and `ACCESS_SAAS_CLIENT_SECRET`). The ID token's email must belong to an active person in Carrel; an unknown or disabled email gets no grant, and a person disabled later loses the door on their next request.
- **Credit:** an AI session is credited by the client's CIMD name (for example "Claude Code") on every draft, flag and publish.
- **No role logic in the MCP layer:** tools call the same functions as the buttons, and those refuse. `npm run check:mcp-roles` fails on a role test anywhere in `app/lib/mcp/`.
- **Reachability:** `carrel-mcp.dustinedwards.info` has a hostname Access application with a Bypass policy, which Cloudflare applies before the Worker-level application; `carrel.dustinedwards.info` stays fully behind Worker-level Access.

| Tool | Who | What |
|---|---|---|
| `list_projects`, `search_items`, `read_item`, `preview`, `get_checks` | anyone with a role | read through the same functions as the pages |
| `save_draft` | Editor, Owner | a new AI draft beside the person's own; never over it, never to the site |
| `add_finding` | anyone with a role, reviewers above all | a flag on a post, credited to the client |
| `publish` | the Owner's own sessions | the post as saved on the site at `expected_version`; refused while any flag is open; recorded as "published by <client> on Dustin's instruction"; emails Dustin an unpublish link |
| `list_book_files`, `read_book_file`, `check_book_text` | anyone with a role on the book | the book's files, a file with its version and flags, and the checks run on text without saving |
| `save_book_draft` | Editor, Owner | a new AI draft of a book file beside the person's own; never committed to Git |
| `add_book_finding` | anyone with a role, reviewers above all | a flag on a book file; a recheck never withdraws it, and it holds export |
| `draft_social_post` | the Owner's own sessions | a post for the social queue, by event id or by account, project and item |

A **reviewer** is a person row with `is_reviewer = 1` (another company's agent), signed in through the same door with its own email: it reads and flags through `/mcp`, never saves or publishes, and is refused at the browser door. AI drafts and flags show in the post's editor, and the project's Posts list shows a post that exists only as a draft (yours or an AI's, `test/waiting.test.ts`) and marks a post with AI drafts waiting; only the Owner dismisses a flag. If the email after an AI publish fails, the publish stands and the health check reports it until it is sent.

## Media

Each site's files stay in that site's own storage and are served by the site; Carrel is only the screen, over the site API's media group (site-api v0.2.0). Nothing about serving an image depends on Carrel.

- **The library** (`/p/<project>/media`): browse and search the site's files, see each one's details and every place the site's reference check finds it used, upload, and delete.
- **In the editor:** paste or drop an image, or use Insert image, and it uploads to the site; From library inserts a file already there. Either way the alt text is asked for before anything goes into the post, and the post gets the site's own figure markup (`app/lib/site-markdown.ts`), pointing at the site's own address for the file.
- **Limits are the site's.** Carrel reads the accepted types and the size limit from the site's meta and refuses anything else before sending it. The site API checks again, bytes included.
- **Deletes are the site's to decide.** A file a post uses is refused, with every post named. Delete asks once more before it acts, because nothing brings the file back.
- **Images load from the site.** The page's image policy names each configured site origin, and nothing else.
- **Health.** The conformance run includes the media checks, all of which a conforming site refuses. The suite's real upload round trip stays off, so the health check never stores a file.
- **Not in v0.2.0:** bulk actions, trash, tags, folders and editing a file's alt text after upload. The site's own media screen keeps those until they have routes.
- **Authorship:** an upload or delete writes one row in `changes` (migration 0007): the person, the AI client when it came through the AI door, the project, the site's media id, and the same change id Carrel sent the site, so the two histories join. A refused upload or delete writes nothing.

## Google

Two separate accesses (design decision 6), and no `drive.readonly` anywhere:

- **The service account** (`GOOGLE_SA_KEY`, the whole JSON key file) reads the manuscripts folder's metadata (`drive.metadata.readonly`) and Search Console (`webmasters.readonly`). Every request it makes passes an allowlist in `app/lib/google/service-account.server.ts`: listing files and the Search Console query. Anything else, a Drive write or a file's content, is refused in code before it is sent.
- **Dustin's grant** (`drive.file` only) is for Send to Docs and Import. Its refresh token sits in D1, encrypted with AES-GCM under `GOOGLE_TOKEN_KEY`.

What it gives:

- **Manuscripts** (`/manuscripts`, the Owner's): the shared folder and its subfolders, as metadata (name, type, dates, owners and last editor), refreshed by the cron so files added later appear. Search runs in Drive's own full-text search, so manuscript text never enters Carrel. Open goes to Google.
- **Send to Docs** copies a post's body into a new Doc. The frontmatter stays in Carrel. **Import** brings the Doc back as a new working draft under that frontmatter, and is refused while a working draft exists.
- **Search Console** per page, 28 days of settled data, fetched at most daily, shown in the post's editor.
- **Health:** the key's age (counted from the first time Carrel saw it; fails past 90 days), whether Google still takes it, and whether the `drive.file` grant still refreshes.

## Social

`/social` (the Owner's) holds the accounts, the posts waiting on Dustin, and the record of every post. A post only ever announces a piece that went live through Carrel, and it comes from, in order (design decision 5):

1. a draft stored ahead by the session that finished the piece (`draftSocialPost`, which the `draft_social_post` MCP tool calls);
2. else the Claude Code routine, fired through its API trigger with every waiting item in one run (after a 30-minute gathering delay, at most 3 runs a day, plus a nightly sweep); the routine stores its drafts the same way;
3. else, when the routine refuses the run, its daily cap is reached, or it drafted nothing within 3 hours, the account's template. The health check fails until Dustin marks each template post seen.

Every post is linted (the AI-habits list, the "not X, it's Y" construction, the platform's length, an opening @handle). A post with a finding is held. Otherwise the account's switch decides: approve each post, or automatic. The personal account is always approval, and the database refuses otherwise. Sending keeps to each account's daily cap and gap between posts, and to X's monthly budget ($0.015 a post, $0.20 with a link). Every request to a platform passes an allowlist of the endpoints that create a session or an original post. A reply, quote, follow, like or message is refused before it is sent.

Credentials are secrets named for the account key, with dashes as underscores: `SOCIAL_<KEY>_BLUESKY_APP_PASSWORD`, or `SOCIAL_<KEY>_X_API_KEY`, `_X_API_SECRET`, `_X_ACCESS_TOKEN` and `_X_ACCESS_SECRET`. The routine is `SOCIAL_ROUTINE_URL` and `SOCIAL_ROUTINE_TOKEN`. No AI API key or subscription token is stored anywhere.

## People and flags

- **People** (`/people`, the Owner only; anyone else gets a 404): who is in Carrel, their kind (Owner, person, or reviewer), and their role on each project. The Owner adds a person, shares a project as Reader or Editor, removes a role, and disables or re-enables someone. Everything goes through `app/lib/people-admin.server.ts`, which checks the Owner. It refuses a second Owner (the database refuses one too), disabling or re-roling the Owner, and a reviewer as Editor (reviewers read and flag only).
- **Access is outside Carrel.** Adding a person here does not let them past Cloudflare Access, and the page says so after each add, naming where to allow the same email:
  - Carrel's pages: the Worker's Access policy. The Worker's Access tab offers only *Cloudflare account* and *Email domain*, so one extra address goes in an Emails rule in Zero Trust > Access controls > Policies, or on the Worker's application in Zero Trust.
  - The AI door: the *Carrel people* policy of the *Carrel AI Door* application.
  - Someone without a Cloudflare account signs in with an emailed code only if One-time PIN is set up, under Zero Trust > Integrations > Identity providers.
- **Flags** (`/p/<project>/flags`): every flag on a site project, open first, from checks, AI sessions and reviewers, including flags on items the site does not have, which no editor page reaches. Anyone who can read the project sees them. Only the Owner dismisses, through the editor's own dismiss function, so a dismissal is recorded the same way.

## Who may do what

| Action | Reader | Editor | Owner |
|---|---|---|---|
| See the list, open a post, preview | yes | yes | yes |
| Autosave a working draft (private to the person) | | yes | yes |
| Save a draft post to the site | | yes | yes |
| Save changes to a published or scheduled post | | | yes |
| Publish, schedule, return to draft | | | yes |
| Save a book's file to Git (it changes nothing public) | | yes | yes |
| Read a book's flags and authorship record | yes | yes | yes |
| Dismiss a flag, export a book | | | yes |
| Browse the media library | yes | yes | yes |
| Upload media, insert an image into a post | | yes | yes |
| Delete a media file from the site | | | yes |
| See a project's flags list | yes | yes | yes |
| Dismiss a flag | | | yes |
| Manage people and their roles | | | yes |

A person with no role on a project gets the same 404 as for a project that does not exist.

The roles are checked in `app/lib/content.server.ts`, `app/lib/books.server.ts` and `app/lib/ai.server.ts`, not in the routes or the MCP tools, so both doors meet the same rule. A first publish asks for confirmation, as the site's own editor does.

## Copied code

The editor is copied from `DrDustinEdwards/dustinedwards-info@6e0f8c9`. Each file's header names its source and what changed.

| Carrel file | Site source | Changed |
|---|---|---|
| `app/components/editor/markdown-editor.tsx` | `app/components/admin/markdown-editor.tsx` | Image upload removed until media arrives in stage 3; prose theme; read-only mode for Readers. |
| `app/components/editor/md-editor-toolbar.tsx` | `app/components/admin/md-editor-toolbar.tsx` | Insert image button removed. |
| `app/components/editor/md-editor-commands.ts` | `app/components/admin/md-editor-commands.ts` | Nothing. |
| `app/components/editor/use-link-palette.ts` | `app/components/admin/use-link-palette.ts` | Nothing. |
| `app/components/editor/roving-focus.ts` | `app/components/admin/roving-focus.ts` | Import path only. |
| `app/lib/roving.mjs` | `app/lib/admin/roving.mjs` | Nothing. |
| `app/lib/reading-time.mjs` | `app/lib/content/reading-time.mjs` | Nothing. |
| `app/lib/publish-transition.mjs` | `app/lib/editor/publish-transition.mjs` | Nothing. |
| `app/app.css` (the `md-*` rules) | `app/styles/admin-editor.css` | Mapped onto Carrel's tokens. |

Some of the site's editor is deliberately not copied:

- **`frontmatter.ts` and `publish-policy.mjs`:** Carrel edits the post's whole file, frontmatter included, as the site stores it. The site's adapter parses it and enforces the publish policy, so there is one authority for both.
- **`draft-buffer`:** replaced by autosave to D1.
