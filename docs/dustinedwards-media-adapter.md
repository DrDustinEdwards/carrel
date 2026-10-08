# dustinedwards.info: the media writes adapter (site-api v0.4.0)

For the seat to post as a dustinedwards job once site-api has a `v0.4.0` tag. Carrel's side is done and waits on this: until the site's adapter has these methods, the site's meta omits `mediaAlt`, `mediaTags` and `mediaTrash`, and Carrel hides alt-text editing, tags, the trash and selection for that site. Nothing breaks in the meantime.

The site's own media screen (`app/routes/admin.media._index.tsx`) is not touched by this job. The point is one write path: the new adapter methods and the admin action handlers in `app/lib/media/actions.server.ts` both call the same small functions, so a rule changed in one place changes in both.

## What Carrel sends

Carrel talks to the site only through site-api. For a media file it sends (all with a `changeId`, and, except for delete, the `expectedVersion` it last read):

| Call | Adapter method | Answer |
|---|---|---|
| `PUT /media/:id/alt` | `setAlt(id, { alt, expectedVersion, changeId })` | `{ version }` after the write |
| `PUT /media/:id/tags` | `setTags(id, { tags, expectedVersion, changeId })` (the whole tag set) | `{ version }` |
| `POST /media/:id/trash` | `trash(id, { expectedVersion, changeId })` | `{ version }` |
| `POST /media/:id/restore` | `restore(id, { expectedVersion, changeId })` | `{ version }` |
| `POST /media/bulk`, `POST /media/trash/empty` | none: site-api loops over the methods above and `delete` | per file |

Bulk and empty-trash need no new site code. site-api calls the adapter once per file, in order, and turns each file's `VersionConflictError`, `NotFoundError`, `RefusedError` or `MediaInUseError` into that file's outcome. `list` already receives `tag` and `trashed: "only"` in its query.

## Version

A file's version is opaque to Carrel, but it must change on every write to alt, tags or trash state, and it must be checked atomically. `media.updated_at` is not enough: `datetime('now')` has one-second resolution, so two writes in a second would share a version.

Recommended: add one column, `rev INTEGER NOT NULL DEFAULT 0` to `media` (a D1 migration), bump it in every one of the four writes, and expose `version = "r" + rev`. Do the check in the same statement as the write:

```sql
UPDATE media SET alt = ?, rev = rev + 1, updated_at = datetime('now')
WHERE key = ? AND rev = ?
```

When no row changed, read the row again: absent means `NotFoundError`; present means `VersionConflictError(currentVersion)`. The write and the version check being one statement is what makes a stale write a 409 and never a lost update. Other writers (the pipeline's `upsertDerivedMedia`, the rebuild) must not touch alt, tags or trash state, as they already do not; they may leave `rev` alone.

`itemOf` in `app/lib/carrel/media-adapter.server.ts` then also returns `version`, `tags` (`parseTags(row.tags)`) and `trashedAt` (the row's `trashed_at` as an ISO time, or null), so the library shows them and holds the version it will send back. These fields are optional in the contract, so a site that has not shipped the adapter still parses.

## Reuse, so the site keeps one write path

`app/lib/media/actions.server.ts` today mixes the form handling (reading `FormData`, building the message) with the write. Split each handler into a small function that takes plain values and returns plain values, keep the handler as a thin wrapper that reads the form and calls it, and have the adapter call the same function.

- **Alt text.** Core: `applyMediaAlt(env, key, alt, expectedRev?)`. Keeps the existing rules: only a managed key (`isManagedKey`), and saving alt rewrites no post. `setMediaAlt(env, form)` becomes `applyMediaAlt(env, key, String(form.get("alt")))` with no version (the admin form has none), so the admin keeps working unchanged. The adapter's `setAlt` calls it with `expectedRev` parsed from `expectedVersion`.
- **Tags.** Core: `db.setMediaTags(env, key, tags)` is already the only tag writer, and `serialiseTags` owns the stored form. The adapter's `setTags` passes `input.tags` (already in the contract's spelling: lower case words joined by hyphens, at most 12 per file, at most 32 characters each) and compares the contract's spelling with `normaliseTags` from `tags.mjs`; if the site's normaliser would change a tag, throw `RefusedError` naming it, so Carrel's list and the site's stay the same. `setMediaTags` in `db/media.ts` gains the `rev` check and bump.
- **Trash and restore.** Core: `trashMediaRecord` and `restoreMediaRecord` in `db/media.ts` (they already move only `trashed_at` and leave R2 and the public address untouched, so a trashed file a post cites keeps rendering). Add the `rev` check and bump to both. They already report `moved` and `restored`; when `moved` is false for a stale or already trashed file, resolve it by re-reading: stale is a `VersionConflictError`, already in the target state with a matching version is a success returning the current version. A static key is refused with `RefusedError`, as `delete` does.
- **Delete and empty trash** are unchanged: `adapter.delete` already runs `mediaDeleteVerdict` and `claimMediaKeyForDelete`, which is the same check `emptyMediaTrash` in `actions.server.ts` repeats by hand. Site-api's empty-trash calls `adapter.delete` for each trashed file, so a file a post cites is refused with its uses (`MediaInUseError`) and stays in the trash. Optionally make the admin `emptyMediaTrash` loop call the same function.
- **List.** `listMedia` already accepts `tag` and `trashed` (`listMediaPage`). In the adapter's `list`, pass `tag: query.tag` and `trashed: query.trashed === "only"`; without `trashed`, trashed rows stay out, which `notTrashed()` already does.

In the adapter object, add `setAlt`, `setTags`, `trash` and `restore` as methods. Offer all four together: site-api reports `mediaTrash` only when both `trash` and `restore` exist.

## Cache and the public pages

None of the four writes changes a file's bytes or address, and no post is rewritten (alt is contextual: only later insertions use it). So no cache purge is needed. If the site later purges anything on a write, run it inside the method, as the adapter contract asks, so the write and its purge are one unit.

## Folders

The site's `media` table has no folders (no folder or path column; `role` and `kind` are classifications, not places), so this job adds none and Carrel's library has none.

## Tests to add to the site

- Each of the four methods: a fresh version succeeds and moves the version; a stale one throws `VersionConflictError` with the current version and changes nothing; a missing key is `NotFoundError`; a static key is refused.
- Two writes in the same second still conflict (the reason for `rev`).
- `list` with `tag` and with `trashed: "only"`; a trashed file is absent from the default list and present in the trash.
- The admin handlers still behave as before (the thin wrappers).
- Run site-api's conformance suite against the adapter (`runConformance`, v0.4.0 cases): it includes stale-version and malformed-body refusals for each write.

## Order of work for the site job

1. Repin `@dustinedwards/site-api` to the `v0.4.0` tag.
2. Migration for `media.rev`; version checks in `db/media.ts`.
3. Split the admin handlers into core functions; point the adapter at them.
4. Extend `itemOf`, `list`, and add the four methods; run conformance.
5. Deploy; Carrel's library then shows the tools on its next load with no change in Carrel.
