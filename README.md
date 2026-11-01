# carrel

Carrel: a private writing hub for articles across sites, books and manuscripts (app code only; no writing is stored here).

Current state is `carrel/core.md` in Capsid.

- **The private shell:** a React Router Worker that admits a request only when Cloudflare Access has signed it and its email belongs to an active person in Carrel. It adds per-project roles and a health check that emails on a change of state.
- **Sites through [site-api](https://github.com/DrDustinEdwards/site-api):**
  - the one view of the site's posts: Capsomer's posts list over site-api's content kit, with status tabs and the Trash, search, and the filters the site applies;
  - the formatted editor (Tiptap) and the site's CodeMirror Markdown editor in a prose layout, both live in the file's shared room, where everyone with a role on the project types at once (see Co-editing);
  - the site's own render in a sandboxed preview;
  - the search and sharing checks on a post as it is typed (`app/lib/seo-checks.ts`): a search title over Prelum's `SERP_TITLE_LIMIT` (60) or empty, a description missing, over `SERP_DESCRIPTION_LIMIT` (155) or under 50, an image in the body with no alt text, and no card image, beside the search result and link card the post will make (title, description, image URL, canonical URL). Each site's fields are one entry in `SOCIAL_FIELDS`. They flag and never hold a save, in the editor, on an AI draft's page and in `carrel_check_post_text`, `carrel_save_draft` and `carrel_get_checks`. The one exception is alt text: an image with none blocks the post going out (below, **Alt text blocks a publish**);
  - saving and publishing, by role;
  - a Content Security Policy on every page.
- **Security headers:** every response on both hosts, redirects and refusals included, carries the portfolio's shared set from [site-runtime](https://github.com/DrDustinEdwards/site-runtime) (the OWASP Secure Headers Project's values: HSTS, framing refused, nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP and the rest) and a Content-Security-Policy built from Carrel's own list, all in `workers/security-headers.ts`. Static files get the same set from `public/_headers`, which every build writes with site-runtime's `headersFile` (`vite.config.ts`). Violations are reported to `/csp-report` on the AI door, the one host a browser reaches without Access (`workers/csp-report.ts`, which logs and stores nothing, rate limited per address by the `CSP_REPORT_RATE_LIMIT` binding). Every action reads its form to a byte ceiling (`app/lib/form.server.ts`). `test/csp.test.ts` runs site-runtime's `checkSecurityHeaders` on the signed-in responses the live check cannot reach.
- **Books in the private writing repository:**
  - the book view, chapter view and a file editor for scenes, bible entries and outlines (the same editor and the same shared room; Save commits to Git with the version it expects to replace);
  - the checks on save: scene headers, continuity and timeline against the bible, world rules, the AI-habits lint and voice;
  - the authorship record, as a Markdown report;
  - export to ePub and Word, and a print page for PDF.
- **AI work through MCP tools in the Worker:** read, search, preview, AI drafts beside yours, flags from checks and reviewers, and publish by instruction for the Owner's own sessions, refused while a flag is open and emailed with an unpublish link.
- **Google:** the manuscripts index and search through a read-only service account, Send to Docs and Import through a `drive.file` grant, and Search Console per page.
- **Social (nothing posted until accounts are connected):** a queue that announces pieces that went live, from a draft stored ahead, else a Claude Code routine, else a template, with the AI-habits lint, per-account switches and caps, and no reply code at all.

## Develop

```sh
npm install                  # also creates wrangler.jsonc from the example
npm run db:migrate:local
npm run seed:owner -- you@example.com "Your Name"
npm test                     # Vitest in workerd with local D1
npm run typecheck
npm run build
npm run check:mcp-roles      # no role logic in app/lib/mcp/
npm run check:conformance    # the official MCP conformance suite, against the baseline in .conformance.json (devkit-conformance)
npm run check:plants         # each gate above, seen red on a planted violation (several minutes)
npm run check:a11y           # an axe scan (WCAG 2.2 A and AA) of every screen, both themes, desktop and phone
npm run check:bloat          # dead code (Knip) and duplicates (jscpd) fail on growth; JS and CSS weight per route warns
```

GitHub Actions runs all of these on every push and pull request (`.github/workflows/ci.yml`); none needs a secret. `npm test` also runs `scripts/check-deploy.mjs`, which proves the deploy script never deploys after a failed migration, build or id check. A push to main then runs the `deploy` job (secrets: see `docs/auto-deploy.md`).

## The look

Carrel's interface is [Capsomer](https://github.com/DrDustinEdwards/capsomer): its shell (rail, top bar, phone tab bar), tokens, components and fonts, with Carrel's own CSS in `app/app.css` limited to the page frame and the few rules the writing screens need. The fonts (Schibsted Grotesk, Martian Mono, Source Serif 4) are self-hosted from the build; nothing loads from another origin, so the policy (`workers/security-headers.ts`) names no font or style host. Carrel is private, so Web Analytics stays off it. A dashboard exclusion by hostname needs the Pro plan, so instead every HTML response carries `Cache-Control: ..., no-transform` (`workers/gate.ts`, and the consent page in `app/lib/mcp/door.ts`; `test/access.test.ts` and `test/door.test.ts` pin it), which Cloudflare's Web Analytics FAQ says keeps the proxy from injecting the beacon. The cost is that those HTML responses are not compressed by Cloudflare; scripts, styles and fonts still are. The CSP is deliberately not loosened for Cloudflare's beacon (`cloudflareWebAnalytics: false` in `workers/security-headers.ts`). The only components Carrel keeps are `app/components/editor` (the writing surface around Capsomer's markdown editor) and `app/components/media` (image upload and "Insert from library").

`npm run harness` builds and serves the real app on http://127.0.0.1:5199 with the Access gate replaced by a header naming the viewer (`x-harness-viewer`: `dustin@harness.invalid` the Owner, `rosa@harness.invalid` an Editor, `sam@harness.invalid` a Reader) and a fake site, writing repository and Google (`test/harness`). It needs no Cloudflare credentials. `node scripts/screens.mjs <directory>` writes a screenshot of every screen in both themes at desktop and phone widths, for looking at.

Every request without a valid Access token is refused, locally too, so the app answers 403 until it runs behind Access.

The tests never reach the network. Site tests run Carrel's code against site-api's own handler over its in-memory reference adapter (`test/site.ts`).

## Deploy order (Carrel is never public)

1. `npx wrangler d1 create carrel`, put the id in `wrangler.jsonc`, `npm run db:migrate:remote`, `npm run seed:owner -- <email> "<name>" --remote`.
2. `npm run deploy` with no route: `workers_dev` and `preview_urls` are false, so nothing reaches the Worker yet.
3. Make a hostname Access application for `desk.dustinedwards.info` (not Worker-level Access, which refuses the WebSockets the co-editing rooms need: docs/coediting.md) and `Get-Clipboard | npx wrangler secret put ACCESS_AUD` with its AUD tag.
4. Uncomment `routes` in `wrangler.jsonc` and deploy again to add `desk.dustinedwards.info`.
5. From then on a merge to main deploys itself, migrations first: see `docs/auto-deploy.md`.

## Connecting a site

A project is a site when its `site` column names an entry in `app/lib/sites.server.ts`. Migration `0002` creates the dustinedwards.info project, `0014` the germomics one, `0016` the Foxhound and Foxing ones, `0017` the txasm and julieedwards.info ones and `0029` the BioScience Writers one.

Each site's origin is a var in `wrangler.jsonc.example` (`SITE_DUSTINEDWARDS_ORIGIN`, `SITE_GERMOMICS_ORIGIN`, `SITE_FOXHOUND_ORIGIN`, `SITE_FOXING_ORIGIN`, `SITE_TXASM_ORIGIN`, `SITE_JULIEEDWARDS_ORIGIN`, `SITE_BSW_ORIGIN`), exactly the domain the site's own job confirmed its Worker serves. Its key is a secret, the same value the site holds:

```powershell
Get-Clipboard | npx wrangler secret put SITE_DUSTINEDWARDS_KEY
Get-Clipboard | npx wrangler secret put SITE_GERMOMICS_KEY
Get-Clipboard | npx wrangler secret put SITE_FOXHOUND_KEY
Get-Clipboard | npx wrangler secret put SITE_FOXING_KEY
Get-Clipboard | npx wrangler secret put SITE_TXASM_KEY
Get-Clipboard | npx wrangler secret put SITE_JULIEEDWARDS_KEY
Get-Clipboard | npx wrangler secret put SITE_BSW_KEY
```

Adding a site is config: an entry in `SITES` (name, origin var, key secret, the site's own new-item source, the items it keeps public, its Search Console property), the origin var and key in `app/env.d.ts` and the example config, a migration inserting its project, and, when the site has its own figure syntax, one line in `FIGURES` in `app/lib/site-markdown.ts` (without one, an image goes in as plain Markdown). The health check, the image policy and the cron's index refresh loop over every entry. `test/sites.test.ts` covers germomics.

Until the key is set, the site shows as not connected, and the health check reports it as not connected rather than failing. Once it is set:

- the health check runs site-api's conformance suite against the site every 15 minutes and emails on a change of state;
- the same cron refreshes the one view's index.

## Connecting the writing repository

A project is a book when its `book` column names a folder in `DrDustinEdwards/writing` (New book, on the home page, for the Owner). Carrel reaches the repository only through the GitHub App `carrel-writer` (design setup step 8), installed on `writing` alone with contents read and write. Each installation token Carrel asks for is narrowed again to that repository and to contents.

```powershell
Get-Clipboard | npx wrangler secret put NOVELS_APP_ID                        # the App's numeric id
Get-Content <the-downloaded-key>.pem -Raw | npx wrangler secret put NOVELS_APP_PRIVATE_KEY
```

The key goes in as GitHub downloads it (PKCS#1, "BEGIN RSA PRIVATE KEY"); Carrel converts it. Until both are set, books open read-only from Carrel's index, Save explains why it is waiting, and the health check reports `writing` as not connected rather than failing. Once they are set, the health check asks GitHub for a token every 15 minutes.

### The layout Carrel reads

```text
shared/voice/*.md              Dustin's own passages, which the voice scan reads a scene against
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
| voice | site-runtime's `slopScan` against Dustin's own writing (`shared/voice/` and up to four of the book's scenes whose status starts done, final, finished or complete, never the scene itself): a sentence well past his long ones, a run all the same length, a model's filler, a model's word his writing never uses, a joiner dash or "not X, it's Y" where his writing has none, a closing list of padding |

There is no global word list: a word Dustin uses is never flagged. A session drafting a scene gets excerpts of the same writing with `carrel_read_book_file`, among them a long sentence of his and a short one. Every check has a planted problem that must be flagged and a clean twin that must not (`test/checks.test.ts`).

## Importing a manuscript from Word

A manuscript that starts as Word files (exported from Google Docs with File, Download, Microsoft Word) is converted once into a book in the writing repository, then reviewed as a pull request there. Nothing is sent anywhere; the importer reads the files and writes Markdown into a local clone.

```powershell
git clone https://github.com/DrDustinEdwards/writing.git C:/dev/writing
git -C C:/dev/writing switch -c import-paluxy-portal
npm run import:docx -- C:/path/to/manuscript-folder --book paluxy-portal --novels C:/dev/writing
```

- A folder's `.docx` files are read in name order, so name them `01-...`, `02-...`. Single files can be listed instead.
- In each file, a **Heading 1** starts a chapter (`chapters/NN-name/`); a file with no Heading 1 is one chapter named after the file. The **Title** paragraph becomes the title in `book.md` (or pass `--title "..."`).
- A paragraph that is only a scene-break mark (`* * *`, `***`, `#`, `~`) starts a new scene (`NN-first-words.md`). Empty paragraphs never do.
- Italics become `*...*`, bold `**...**`. Each scene opens with an empty scene header for you to fill.
- Anything it cannot convert cleanly (tables, images, footnotes, comments, tracked changes, lists, line breaks inside a paragraph, headings below Heading 1, centered text, text before the first chapter) is **flagged, not guessed**: an `<!-- import: ... -->` line where it happened, and a row in `<book>/build/import-report.md`. Remove every marker before exporting.
- It refuses to write into a book that already has `chapters/`.

Then review the result in the clone, commit it, and open a pull request in the writing repository. The importer's tests (`test/import.test.ts`) run on a short test document built from `test/fixtures/import/test-manuscript.mjs`.

## The AI door (MCP)

The AI door is its own hostname, `carrel-mcp.dustinedwards.info` (design decision 7, corrected). Every request that arrives there is an AI session, and every other hostname is the browser door behind Access; the hostname alone decides, never the email. The pages are never served on the AI host, and `/mcp` on the browser's host is just a page that does not exist.

- **Protocol:** the official MCP SDK v2 (`@modelcontextprotocol/server` 2.0.0) through `agents`, stateless, at `/mcp`. The design-center era is 2026-07-28; 2025-era clients (Claude Code and claude.ai, as last measured) are answered by site-runtime's era router (`routeMcpEra`), handed `isLegacyRequest` at the one call site in `app/lib/mcp/server.ts`, which carries the removal condition.
- **Sign-in:** the door is an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider` 1.1.0, exact). Claude, Claude Code and ChatGPT present a metadata URL as their `client_id` (CIMD). Grok and Gemini, which still need Dynamic Client Registration as of 2026-10-09, use a tightened `/register` (site-runtime's `registrationRefusal` and `registrationLimited`, ruling 2026-10-10 rule 13): only exact allowlisted callbacks (site-runtime's `DCR_CALLBACKS`, plus any exact https callbacks in the var `DCR_REDIRECT_URIS`), only the code and refresh grants, a few registrations an hour per address and a ceiling a day, and a registration grants nothing by itself. After a consent page (site-runtime's `loginHandler`), shown for every authorization of every client, the person signs in with Cloudflare Access for SaaS (OIDC; secrets `ACCESS_SAAS_CLIENT_ID` and `ACCESS_SAAS_CLIENT_SECRET`). The ID token's email must belong to an active person in Carrel; an unknown or disabled email gets no grant, and a person disabled later loses the door on their next request.
- **Scopes:** `carrel.read` and `carrel.write` (site-runtime `mcpScopes`). Least scope first: every grant holds `carrel.read`, and `carrel.write` only when the person ticks "Allow changes" on the consent page. The box starts ticked only when the client asked for `carrel.write`; a client that asks for `carrel.read`, or names no Carrel scope at all, starts unticked. A tool that writes refuses a grant without `carrel.write` and says to reconnect. A grant keeps the scope names it was issued with: `carrel:read` and `carrel:write` (2026-10-10 to 2026-10-31) read as the new names, and `carrel` (before 2026-10-10) as both. A scope only narrows the person's role, never widens it.
- **Security floor (ruling 2026-10-10, rule 12):** every id-taking tool refuses a person the project is not shared with (`test/mcp-ownership.test.ts`); a token must be bound to `https://carrel-mcp.dustinedwards.info/mcp`, checked by the provider and again in the door, and is never passed on to the site or the novels repository; every tool declares its scope, a read-only grant is listed only the tools it can call (site-runtime's `toolsForGrant`, so a write tool is unknown to it, as on every network MCP server), each tool carries the server's icon, the request's abort signal reaches the tool and its outbound fetches, and every call goes through site-runtime's `invokeTool` into the append-only `ToolCallLog` Durable Object (`TOOL_CALL_LOG`): a `refused` row, or a `started` row written before the tool runs (the call is refused if it cannot be written) and a `finished` row (the D1 `mcp_calls` table keeps the calls from before), and every sign-in, admitted or refused, a `sign-in` row (loginHandler's `audit`); a foreign `Origin` gets 403 before any token is read, and each person has 30 requests a minute (`MCP_RATE_LIMIT`); and every answer that carries text from the site, the novels repository or other people's flags and drafts goes through site-runtime's `outsideResult`: the shared notice that it is data, never instructions, then the text inside `<data label="carrel-outside">`. The nightly `tool-call-log-export` job copies the log to the R2 bucket `carrel-desk-tool-calls` (`AUDIT_BUCKET`, lock rule on `tool-calls/`) and prunes copied rows past 90 days, and `/health`'s `tool-call-log` check is site-runtime's `auditLogCheck`.
- **Named agent keys:** for an agent that cannot complete OAuth (Grok Build could not do CIMD as of 2026-09-07). One Worker secret per agent, and the secret's name is the agent: `AGENT_KEY_GROK` is `grok`. The agent sends it as `Authorization: Bearer <key>` on `/mcp`; it is compared in constant time over SHA-256 digests (site-runtime's `./agent-keys`, re-exported by `app/lib/agent-keys.server.ts`), and the name is never read from the request. The agent is the person row `agent:grok` in People (added in People under "Add an AI agent"), found again on every request, so disabling the row revokes the key at once. Its role is whatever People says (Editor on `dustinedwards.info` to start: read, save AI drafts, flag, preview); the key grants nothing, so `carrel_publish_item` refuses an agent with the Owner-only message, and a row marked Owner is refused as an agent. It is inert until a secret exists, and any other Authorization header (an OAuth token, a malformed one) goes to the OAuth path unchanged. Writes are credited to `agent:grok`, in the AI draft's client and person and in a flag's text, never to Dustin. Setting up one: generate the key into a file in your home folder without printing it, `Get-Content <file> -Raw | npx wrangler secret put AGENT_KEY_GROK`, add the agent and set its role in People, then point the agent at `https://carrel-mcp.dustinedwards.info/mcp` with that key as a bearer token (Grok Build: `bearer_token_file` in `~/.grok/config.toml`, or `grok mcp add --transport http carrel <url> --header "Authorization: Bearer <key>"`). To rotate, put the secret again; to revoke, delete the secret or disable the agent in People.
- **Credit:** an AI session is credited by the client's CIMD name (for example "Claude Code") on every draft, flag and publish.
- **No role logic in the MCP layer:** tools call the same functions as the buttons, and those refuse. `npm run check:mcp-roles` fails on a role test anywhere in `app/lib/mcp/`.
- **Reachability:** `carrel-mcp.dustinedwards.info` has a hostname Access application with a Bypass policy, and `desk.dustinedwards.info` has its own hostname application; `workers/gate.ts` checks the Access token on every Desk request either way.

Every tool is named `carrel_<action>_<resource>` and carries all four annotation hints. `carrel_search_items` returns 50 posts to a page by default (`limit` up to 100), with `has_more` and an opaque `next_cursor` to pass back as `cursor`.

| Tool | Who | What |
|---|---|---|
| `carrel_list_projects`, `carrel_search_items`, `carrel_read_item`, `carrel_preview_item`, `carrel_get_checks` | anyone with a role | read through the same functions as the pages |
| `carrel_voice_brief`, `carrel_check_post_text` | anyone with a role | what to read before drafting (a few writing rules, the Owner's guide, and excerpts of the published posts holding a long and a short sentence of the author's), and the scan run on text without saving |
| `carrel_save_draft` | Editor, Owner | a new AI draft beside the person's own; never over it, never to the site. The answer carries the writing checks on what was saved |
| `carrel_add_finding` | anyone with a role, reviewers above all | a flag on a post, credited to the client |
| `carrel_publish_item` | the Owner's own sessions | the post as saved on the site at `expected_version`; refused while any flag is open; recorded as "published by <client> on Dustin's instruction"; emails Dustin an unpublish link |
| `carrel_list_book_files`, `carrel_read_book_file`, `carrel_check_book_text` | anyone with a role on the book | the book's files, a file with its version and flags, and the checks run on text without saving |
| `carrel_save_book_draft` | Editor, Owner | a new AI draft of a book file beside the person's own; never committed to Git |
| `carrel_add_book_finding` | anyone with a role, reviewers above all | a flag on a book file; a recheck never withdraws it, and it holds export |
| `carrel_draft_social_post` | the Owner's own sessions | a post for the social queue, by event id or by account, project and item |

A **named agent** is a person row `agent:<name>` that a key resolves to; it is neither Owner nor reviewer, and its role on each project is set in People like anyone's. A **reviewer** is a person row with `is_reviewer = 1` (another company's agent), signed in through the same door with its own email: it reads and flags through `/mcp`, never saves or publishes, and is refused at the browser door. AI drafts and flags show in the post's editor, and the project's Posts list shows a post that exists only as a draft (yours or an AI's, `test/waiting.test.ts`) and marks a post with AI drafts waiting; only the Owner dismisses a flag. If the email after an AI publish fails, the publish stands and the health check reports it until it is sent.

## Co-editing

Everyone with a role on a project edits a post or a book file at the same time, with no locks (Dustin's ruling of 2026-10-10, build step 10). How it works is [docs/coediting.md](docs/coediting.md); who may do what is under Who may do what.

- **One room per file:** a Durable Object (`workers/doc-room.ts`, y-partyserver over Yjs) holds the working copy. Each person's changes reach the others as they type, and work typed offline is sent when the connection is back.
- **Carets and presence:** each person's caret, selection and name in their own color, and who else is here above the text. Names come from the room, which knows who Access let in, never from the other browser.
- **Suggesting:** an Editor or the Owner chooses Editing or Suggesting; a Reader only suggests. A suggestion carries who made it, when, and an optional revision round. The Suggestions panel accepts or rejects one, a round or all; the person who made one withdraws it. A save leaves out every pending suggestion.
- **Comments:** threads on a passage, anchored so they stay put as the text changes; reply, edit, resolve, reopen and delete.
- **Saves:** Save, Publish and Schedule send the room's text through site-api's `expectedVersion` check (Git's sha for a book file), and the revision is credited to the saver "with" everyone else who typed since the last save.

## Voice

Drafts an AI session writes should read like the author, not like a model (`app/lib/voice.server.ts`, the project's Voice tab). Nothing here measures or aims to pass an AI detector.

- **The brief:** the Owner's guide and six excerpts from the newest 40 published posts, one per post, among them one holding a long sentence of the author's and one a short one. Real examples copy a voice better than a description does. No word lists and no measured averages: an average sentence length is a length a model then writes every time.
- **The scan:** site-runtime's `slopScan`, the same one the book checks and the social lint run, against those excerpts: a sentence well past the author's long ones, a run of sentences all the same length, a model's filler, a model's word the excerpts never use, a joiner dash or "not X, it's Y" where the excerpts have none, a closing list of padding, and a run copied from an excerpt. At most twelve findings, each with its line and words, and one instruction: edit only those spans in place and leave every other sentence as it is.
- **Before and after drafting:** a session reads `carrel_voice_brief`, writes from the guide and excerpts, runs `carrel_check_post_text` and fixes only what it names; `carrel_save_draft` answers with the scan on what it saved, and the AI draft page shows it above the draft. It flags; the author edits, and publishing still waits for the Owner.
- **Kept, unused:** `voice_packs.phrases`, `allow`, `profile` and the `voice_cuts` table from the earlier word lists, so the lists the Owner typed are not lost.

## Media

Each site's files stay in that site's own storage and are served by the site; Carrel is only the screen, over the site API's media group (site-api v0.2.0, and the optional writes of v0.4.0). Nothing about serving an image depends on Carrel.

- **The library** (`/p/<project>/media`): browse and search the site's files, see each one's details and every place the site's reference check finds it used, upload, edit alt text and tags, use the trash, and delete.
- **In the editor:** paste or drop an image, or use Insert image, and it uploads to the site; From library inserts a file already there. Either way the alt text is asked for before anything goes into the post, and the post gets the site's own figure markup (`app/lib/site-markdown.ts`), pointing at the site's own address for the file.
- **Limits are the site's.** Carrel reads the accepted types and the size limit from the site's meta and refuses anything else before sending it. The site API checks again, bytes included.
- **Deletes are the site's to decide.** A file a post uses is refused, with every post named. Delete asks once more before it acts, because nothing brings the file back.
- **Images load from the site.** The page's image policy names each configured site origin, and nothing else.
- **Health.** The conformance run includes the media checks, all of which a conforming site refuses. The suite's real upload round trip stays off, so the health check never stores a file.
- **Writes beyond upload and delete (site-api v0.4.0):** a file's **alt text** and **tags** are edited in the details panel (a form each; the versions are the site's, so a stale save is a plain "the file changed" message and the page refreshes to what the site holds). **Trash and restore** are reversible, so an Editor may; the library's **Trash** view lists the trashed files, and the Owner can **Empty the trash** behind a confirm dialog that names every file (without script, the page asks on its own). The tag filter narrows the library to one tag.
- **Selection and the bulk bar:** Editors and the Owner tick files (Capsomer's tile checkbox and bulk bar; the bar needs script) and **Add tag**, **Remove tag**, **Move to trash** (or **Restore**, in the Trash view) or, for the Owner, **Delete for good**, whose confirm dialog names every file. `POST /p/<project>/media/bulk` answers JSON. The site answers file by file, so nothing aborts: the Result panel lists each file as done or left as it was, with the reason, and a file a post uses is refused by the site's check with the post named. At most 100 files a request, as the site allows.
- **Only the Owner deletes for good or empties the trash** (`delete_media`, checked in `media.server.ts` before the site is asked). Alt text, tags, trash and restore are the Editor's (`edit`). `test/media-writes.test.ts` names each refusal.
- **Several files at once:** the upload drop zone takes up to 50 files; each uploads on its own (three at a time) with its own progress bar, and a failed one stays as a tile with the reason and Retry (`app/components/media/upload-queue.tsx`). Without script the form posts every chosen file and the page lists each result. One alt text goes with a single file; several are described one by one after.
- **Caption, focal point, crop, replace (site-api v0.10.0, `mediaCaption`, `mediaFocus`, `mediaReplace`):** the details panel edits a file's **caption** beside its alt text (From library puts it in the figure), sets its **focal point** by clicking the picture or with the arrow keys or two percent fields, with square, wide and tall previews (stored by the site as the R2 object's customMetadata `focus`, "XxY" from 0 to 1, which site-runtime's `./image` reads for its crops), **crops** it in the browser and saves the crop as a new file, and, for the Owner, **replaces** the file with a new one of the same type, or with the crop, under the same id and address, so every post that shows it shows the new one. The crop reads the file's bytes through `GET /p/<project>/media/api?bytes=<id>` (same origin, so the canvas can be exported; JPEG, PNG and WebP only, never SVG). The calls go through site-api's own client (`media.setCaption`, `media.setFocus`, `media.replace`), whose `sizesNeedPurge` says whether the site may still serve resized copies of the old file.
- **Each write is optional per site.** Carrel reads `mediaAlt`, `mediaTags` and `mediaTrash` (and the v0.10.0 `mediaCaption`, `mediaFocus` and `mediaReplace`) from the site's meta and hides the alt form, the tag form and filter, the Trash view and the selection tools for what the site lacks; a write that arrives anyway and is answered 501 says "This site does not offer that." The site's adapter for dustinedwards.info is specified in [docs/dustinedwards-media-adapter.md](docs/dustinedwards-media-adapter.md).
- **Site-api v0.13 (Capsomer 0.40.0's library), each where the site's meta offers it:** duplicates (an upload of bytes the site holds links the file already stored, and the inspector lists its twins), usage counts with Unattached and Most used, Type and Orientation filters, **Import from a web address**, **credit and license** (with a note when the license has ended), **turns and mirrors**, the file's **history** with Go back to this, **Shrink** to the site's size, the taken date and caption from the picture's own metadata, and **Suggest** tags and alt text. The model is asked only when an Editor or the Owner presses Suggest (`suggest=1`), and each suggestion is written only when the person accepts it, as an ordinary tag or alt text save. **Live updates**: with script the library asks `GET /p/<project>/media/api?changes=<cursor>` (the kit's `loadMediaChanges`, behind the same project role as the page) every 15 seconds while visible, and puts what others changed in place. Turns, history and shrink change every page that shows the file, so they are the Owner's, like replace. The authorship record names them `media-import`, `media-credit`, `media-transform`, `media-revert` and `media-resize` (migration 0024).
- **Not here:** folders (the dustinedwards media schema has none; a site whose schema grows them gets a contract change first) and "rebuild from the bucket" (a repair, in Capsid's allowlist work, not a Carrel screen). Capsomer's own media inspector autosaves through a client call; this page keeps server forms, so the versioned writes, their refusals and the authorship record are one path.
- **Authorship:** every media action the site carried out writes one row in `changes`: the person, the AI client when it came through the AI door, the project, the site's media id, and the same change id Carrel sent the site, so the two histories join. Alt text, tags, trash and restore are recorded as `media-alt`, `media-tags`, `media-trash` and `media-restore`, and caption, focal point and replace (migration 0021) as `media-caption`, `media-focus` and `media-replace`, with the file's version before and after. A bulk action writes one row per file, each under its own change id; emptying the trash writes a `media-delete` row per deleted file under the id the site gave it (`<change id>-<n>`). A refused action writes nothing.

## History

The editor's History panel (and the page behind it, `/p/<project>/e/<item>/history`) shows what the site remembers of one post, for any kind of item. It is read-only: looking at history writes nothing to the site or to Carrel, and a Reader may read all of it. The reads live in `app/lib/history.server.ts`, which checks the role like `content.server.ts` does.

- **Revisions** come from the site, newest first, each with who and when. Each opens its source (site-api v0.3.0's `GET /content/:id/revisions/:version`; on an older site the page says it cannot open one).
- **Any two revisions** can be picked and compared. The patch is the site's own (`GET /content/:id/diff`), drawn with Capsomer's `DraftPatch`. "By word" sets the same two texts against each other with Capsomer's `DraftCompare`.
- **Your working draft** can be compared against the site's current text, and against each AI draft saved beside it (also linked from the AI draft page). Both sides are in Carrel, so the patch is built here by `unifiedPatch` in `app/lib/patch.ts`, with the `diff` package the site API already uses, and drawn the same way. "On the site" means the site's current version, published or not.
- **Not here:** restoring a revision. Opening a revision is read-only; putting one back is a wider job.

`test/history.test.ts` drives the route's loader: a Reader's reads, that only GETs reach the site, the order of a picked pair, and each comparison.

## The posts list

The **Posts** tab of a site project is Capsomer's `PostsList` over site-api v0.17.0's content kit (`@dustinedwards/site-api/admin`: `readPostQuery`, `loadPosts`, `runPostsIntent`), the same screen and intents as each site's own admin. Files: `app/lib/posts.server.ts`, `app/routes/project.tsx`, `POST /p/<project>/posts/api` (JSON), `test/posts.test.ts`.

- **The screen.** Status tabs with the site's counts and, where the site has one, the **Trash**; search and the filters the site applies (kind, tag, author, published from and to); each row's title, path, authors and excerpt, and a menu; 50 to a page. A Carrel draft for a post the site does not have yet is listed above it under "Only in Carrel". A site's data kinds (the lab registry, published with no page) stay out of the list, as they stay out of the index.
- **Actions,** each only where the site offers it and the person's role allows: **Add tag** and **Remove tag**, **Duplicate** (a draft copy under the first unused `-copy` id), **Unpublish** with Undo, **Reschedule** and **Cancel the update**, **Move to Trash** and **Restore** (each the other's Undo; a live post leaves the site first), **Delete for good** from the Trash behind a confirm with the count to type, **Rename** (the old address redirects to the new one), and **Get a preview link**. **Refresh from the site** reads the site into Carrel's index, which the editor's links and the AI tools search. Every action is a form post, so it works with no script.
- **One post at a time, nothing aborts.** The kit sends each post as its own write with the version the person saw and a fresh change id; a stale version, a refusal or a post the site does not have leaves that post as it was, and the bar lists every post's outcome. A post with changes in Carrel nobody has saved is left alone by a tag change or a rename, so the changes are not lost.
- **Roles** come from `app/lib/roles.ts` as the kit's permissions, and the kit refuses before the site is asked: a Reader posts nothing, an Editor or Author tags, duplicates, renames a draft and moves posts to the Trash and back, and only the Owner changes what the public sees from the list (unpublish, reschedule, a live post's tags, address or Trash) or deletes for good.
- **Authorship:** every write the site carried out writes one row in `changes`, with the versions before and after and the change id sent to the site. Tags and a duplicate are saves (the duplicate's makes its maker the copy's Author), unpublish, reschedule and cancel are `unpublish`, `schedule` and `unschedule`, a delete is `content-delete`, and Trash, Restore and Rename are `content-trash`, `content-restore` and `content-rename` (migration 0027). A rename's row is under the new id with the old one in `renamed_from`, so the post's Author follows it.

## Mentions

The **Mentions** tab of a site project is Capsomer's `MentionsList` over site-api's content kit (`loadMentions`, `runMentionsIntent`), the queue of webmentions other sites sent about its posts. Carrel is the screen, and the site keeps the table and the rules. Files: `app/lib/mentions.server.ts`, `app/routes/mentions.tsx`, `POST /p/<project>/mentions/api` (JSON), `test/mentions.test.ts`.

- **The screen.** Tabs by state with the site's counts (Waiting, Source not found, Approved, Rejected, All; it opens on Waiting, or All when nothing waits), 50 to a page. Each row has **Approve**, **Reject** and **Delete**, and ticked rows share the bulk bar; with script the keys decide (`a`, `r`, `d`, `z` for Undo). Undo is the opposite decision, or Back to waiting on a site that can reset one. **Delete** asks first with the count to type, and **Remove N expired** sweeps the failed and rejected mentions past the site's window behind a confirm: both remove the only copy of what the sender sent. Everything a stranger sent is drawn as text; the source address is never a link.
- **Who may.** The Owner alone, to read and to decide: the inbox belongs to Dustin alone (his design decision, 2026-09-26), and the site reserves deleting a mention to its admin. `read_mentions` and `decide_mention` in `app/lib/roles.ts` are separate actions, so opening the queue to Editors or Readers to read is one line there. The tab is shown only to a person who may open it; anyone else who asks for the page gets 403, and the site is never asked.
- **One mention at a time, nothing aborts.** Each is its own site write with its own change id, in order, with the version the row showed (the bulk bar names none, so Carrel sends the one the site holds). A stale version, a mention the site no longer has, and one the site refuses leave that mention as it was; the others go on, and the bar lists every outcome. The site saves the decision and clears the post's cache as one step; if the clear fails Carrel says so.
- **Offered per site.** `meta.capabilities.mentions` says the site has the group; without it the screen says so. The health check runs the mentions conformance checks on a site that declares the group (none changes the site) and expects 501 from one that does not.
- **Authorship:** every write the site carried out writes one row in `mention_decisions` (migration 0011, a table of its own because the `changes` table holds posts and files): the person, the AI client if one ever decides, the project, the site's mention id (empty for a sweep), the status the decision left it in, and the change id sent to the site. Back to waiting is `reset` (migration 0027). A refused write writes nothing.

## Google

Two separate accesses (design decision 6), and no `drive.readonly` anywhere:

- **The service account** (`GOOGLE_SA_KEY`, the whole JSON key file) reads the manuscripts folder's metadata (`drive.metadata.readonly`) and Search Console (`webmasters.readonly`). Every request it makes passes an allowlist in `app/lib/google/service-account.server.ts`: listing files and the Search Console query. Anything else, a Drive write or a file's content, is refused in code before it is sent.
- **Dustin's grant** (`drive.file` only) is for Send to Docs and Import. Its refresh token sits in D1, encrypted with AES-GCM under `GOOGLE_TOKEN_KEY`.

What it gives:

- **Manuscripts** (`/manuscripts`, the Owner's): the shared folder and its subfolders, as metadata (name, type, dates, owners and last editor), refreshed by the cron so files added later appear. Search runs in Drive's own full-text search, so manuscript text never enters Carrel. Open goes to Google.
- **Send to Docs** copies a post's body into a new Doc. The frontmatter stays in Carrel. **Import** brings the Doc back into the post's room under that frontmatter, and is refused while the post has changes nobody has saved.
- **Search Console** per page, 28 days of settled data, fetched at most daily, shown in the post's editor.
- **Health:** the key's age (counted from the first time Carrel saw it; fails past 90 days), whether Google still takes it, and whether the `drive.file` grant still refreshes.

## Social

`/social` (the Owner's) holds the accounts, the posts waiting on Dustin, and the record of every post. A post only ever announces a piece that went live through Carrel, and it comes from, in order (design decision 5):

1. a draft stored ahead by the session that finished the piece (`draftSocialPost`, which the `carrel_draft_social_post` MCP tool calls);
2. else the Claude Code routine, fired through its API trigger with every waiting item in one run (after a 30-minute gathering delay, at most 3 runs a day, plus a nightly sweep); the routine stores its drafts the same way;
3. else, when the routine refuses the run, its daily cap is reached, or it drafted nothing within 3 hours, the account's template. The health check fails until Dustin marks each template post seen.

Every post is linted (the AI-habits list, the "not X, it's Y" construction, the platform's length, an opening @handle). A post with a finding is held. Otherwise the account's switch decides: approve each post, or automatic. The personal account is always approval, and the database refuses otherwise. Sending keeps to each account's daily cap and gap between posts, and to X's monthly budget ($0.015 a post, $0.20 with a link). Every request to a platform passes an allowlist of the endpoints that create a session or an original post. A reply, quote, follow, like or message is refused before it is sent.

Credentials are secrets named for the account key, with dashes as underscores: `SOCIAL_<KEY>_BLUESKY_APP_PASSWORD`, or `SOCIAL_<KEY>_X_API_KEY`, `_X_API_SECRET`, `_X_ACCESS_TOKEN` and `_X_ACCESS_SECRET`. The routine is `SOCIAL_ROUTINE_URL` and `SOCIAL_ROUTINE_TOKEN`. No AI API key or subscription token is stored anywhere.

## People and flags

- **People** (`/people`, the Owner only; anyone else gets a 404): who is in Carrel, their kind (Owner, person, or reviewer), and their role on each project. The Owner adds a person, shares a project as Reader, Editor or Author, removes a role, and disables or re-enables someone. Everything goes through `app/lib/people-admin.server.ts`, which checks the Owner. It refuses a second Owner (the database refuses one too), disabling or re-roling the Owner, a reviewer as Editor or Author (reviewers read and flag only), and Author for an AI agent or on a book.
- **Access is outside Carrel.** Adding a person here does not let them past Cloudflare Access, and the page says so after each add, naming where to allow the same email:
  - Carrel's pages: the Worker's Access policy. The Worker's Access tab offers only *Cloudflare account* and *Email domain*, so one extra address goes in an Emails rule in Zero Trust > Access controls > Policies, or on the Worker's application in Zero Trust.
  - The AI door: the *Carrel people* policy of the *Carrel AI Door* application.
  - Someone without a Cloudflare account signs in with an emailed code only if One-time PIN is set up, under Zero Trust > Integrations > Identity providers.
- **Flags** (`/p/<project>/flags`): every flag on a site project, open first, from checks, AI sessions and reviewers, including flags on items the site does not have, which no editor page reaches. Anyone who can read the project sees them. Only the Owner dismisses, through the editor's own dismiss function, so a dismissal is recorded the same way.

## Legal pages

A privacy or terms page is an ordinary page on the site (item `page.privacy` or `page.terms`, registered on the site, never made by Carrel) and opens in the normal editor. The **Legal** tab (`/p/<project>/legal`) lists the two, says which are not set up on the site, and holds the shared sections.

- **Fields**: a legal page's frontmatter carries `legal_type` (`privacy` or `terms`), `site_name`, `operator_name`, `contact`, `jurisdiction`, `data_held`, `last_updated` and `banner`. The editor shows them as labeled fields. `banner` is a checkbox that writes the one word `Draft`; the Owner clears it when the page is done. The site's layout decides how to show them.
- **Shared sections** (the `legal_sections` table, migration 0008): text every site says alike, written once. A page names one with `<!-- shared:hosting -->`; on every write to the site Carrel writes the section's text between that marker and `<!-- /shared:hosting -->`, with `{{site_name}}`, `{{operator_name}}`, `{{contact}}`, `{{jurisdiction}}` and `{{data_held}}` filled in from the page's own fields. Each site still publishes its own page, so changing a section changes nothing public until a page is next saved; the Legal tab marks a page whose text is behind its sections. Only the Owner changes a section. A save as draft keeps an empty field's `{{token}}`; a publish, or a save to a live page, is refused naming the empty field or the unknown section. Tests: `test/legal.test.ts`.
- **`last_updated`** is stamped with the day when the Owner publishes a text that changed, or a draft going public, and not by a draft save or a change to a field other than the text.
- **The license page**: dustinedwards.info's `/terms` is the license named by the Dataset JSON-LD and the `Link: rel="license"` header, so Carrel refuses to unpublish `page.terms` (`keepPublic` in `app/lib/sites.server.ts`) and refuses to change the path of any legal page. Its wording can change. The test is `PLANT: the page the site's data license names` in `test/legal.test.ts`.
- AI sessions treat legal pages like any other page: drafts are saved as labeled AI drafts, and only the Owner publishes. A legal page is made by the site, not in Carrel, so it has no Author.

## Who may do what

| Action | Reader | Editor | Author | Owner |
|---|---|---|---|---|
| See the list, open a post, preview | yes | yes | yes | yes |
| Type in a file's shared room (everyone in it sees the change at once) | | yes | yes | yes |
| Comment, reply, and make or withdraw your own suggestions | yes | yes | yes | yes |
| Accept or reject suggestions; resolve anyone's comment thread | | yes | yes | yes |
| Delete someone else's comment | | | | yes |
| Save a draft post to the site | | yes | yes | yes |
| Save changes to a published or scheduled post | | | own posts | yes |
| Publish, schedule, schedule an update to a live post, cancel it, return to draft, restore a live post's earlier text | | | own posts | yes |
| Save a book's file to Git (it changes nothing public) | | yes | | yes |
| Read a book's flags and authorship record | yes | yes | | yes |
| Dismiss a flag, export a book | | | | yes |
| Browse the media library | yes | yes | yes | yes |
| Upload media (several at once), insert an image into a post | | yes | yes | yes |
| Edit a file's alt text, caption, credit and license, tags and focal point, import one from a web address, crop it into a new file, ask for and accept suggested tags and alt text, move files to the trash and restore them | | yes | yes | yes |
| Replace, turn, mirror, shrink or revert a file's bytes under the same address (it changes every page that shows it) | | | | yes |
| Delete a media file from the site for good, empty the trash | | | | yes |
| Read a post's history and compare revisions or drafts | yes | yes | yes | yes |
| Tag, duplicate, rename a draft, move posts to the Trash and restore them, from the posts list | | yes | yes | yes |
| Unpublish, reschedule or rename a live post, move it to the Trash, from the posts list | | | | yes |
| Delete posts from a site for good | | | | yes |
| See a project's flags list | yes | yes | yes | yes |
| See the Legal tab and the shared sections | yes | yes | yes | yes |
| Change or remove a shared section | | | | yes |
| See a site's mention queue; approve, reject or delete a mention; sweep the expired ones | | | | yes |
| Manage people and their roles | | | | yes |

A person with no role on a project gets the same 404 as for a project that does not exist.

**The Author** (Dustin's ruling, 2026-10-29, after EmDash's `content:publish_own`) sits between Editor and Owner: everything an Editor does, and publishing, scheduling and unpublishing the posts they wrote. A post's author is the person whose save created it in Carrel, read from the authorship record (`itemAuthor` in `app/lib/content.server.ts`); a post made anywhere else has no author, so only the Owner publishes it. An Author never publishes someone else's post, dismisses a flag, deletes, replaces a file or manages people. The role is for people on a site's project: People refuses it for a reviewer, an AI agent (agents never publish) and a book project (no posts). An Author's AI sessions still never publish: `carrel_publish_item` is the Owner's own sessions alone (decision 2a). Granting it needs migration 0021.

The roles are checked in `app/lib/content.server.ts`, `app/lib/books.server.ts` and `app/lib/ai.server.ts`, not in the routes or the MCP tools, so both doors meet the same rule. A first publish asks for confirmation, as the site's own editor does.

**Alt text blocks a publish** (Dustin approved, 2026-10-31). Before the text goes out (a publish, a schedule, or a save to a post the public already sees), `writeToSite` refuses it when an image in the Markdown, HTML or a `:::figure` has empty alt text, and the refusal names each image by its address and line. The same rule reaches the editor, where the publish checks show each such image as a failing required check, and the MCP publish tool, which gets the refusal in words. `test/content.test.ts` covers it.

**Scheduling an update to a live post** (site-api v0.10.0, `scheduledUpdates`, DrDustinEdwards/site-api#59). On a published post the editor offers Schedule update: the live post stays as it is, and the site publishes the new text at the chosen time. The editor then says when, offers Edit the scheduled text (it loads into the working draft) and Cancel the scheduled update, and Schedule update again replaces the one waiting. Saving the live post meanwhile asks first, because the waiting update's own text still replaces the live one when it runs. The Posts list marks a live post with an update waiting (`site_items.update_at`, migration 0021). On a site without the capability Carrel offers no Schedule update and refuses one before asking the site, since an older site would take the post down until the time came. The calls go through site-api's own client (`schedule`, `scheduledUpdate`, `cancelSchedule`).
