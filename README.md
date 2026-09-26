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

## Develop

```sh
npm install                  # also creates wrangler.jsonc from the example
npm run db:migrate:local
npm run seed:owner -- you@example.com "Your Name"
npm test                     # Vitest in workerd with local D1
npm run typecheck
```

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

## Who may do what

| Action | Reader | Editor | Owner |
|---|---|---|---|
| See the list, open a post, preview | yes | yes | yes |
| Autosave a working draft (private to the person) | | yes | yes |
| Save a draft post to the site | | yes | yes |
| Save changes to a published or scheduled post | | | yes |
| Publish, schedule, return to draft | | | yes |

A person with no role on a project gets the same 404 as for a project that does not exist.

The roles are checked in `app/lib/content.server.ts`, not only in the routes, so the MCP tools in stage 5 meet the same rule. A first publish asks for confirmation, as the site's own editor does.

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
