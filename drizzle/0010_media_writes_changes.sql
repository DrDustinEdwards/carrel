-- Media writes in the authorship record (job_b4acbaabf747). Editing a file's alt text or tags, moving
-- it to the trash and restoring it are each one row in changes, like an upload or a delete: who (the
-- person, and the AI client when it came through the AI door), which project, which file (item_id
-- holds the site's media id), the version before and after when the site reports them, and the change
-- id Carrel sent the site, so this record joins the site's own history. Emptying the trash and the
-- bulk actions write one row per file, each under its own change id.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt exactly as migrations 0007
-- and 0009 did: the same columns, 'media-alt', 'media-tags', 'media-trash' and 'media-restore' added to
-- the action list, and version_after optional for them as it already is for the other media actions.
-- Every content write still requires it. Nothing references changes by foreign key, so the rebuild is a
-- copy and a rename.
--
-- Apply this before deploying the code that writes: until it is applied, the insert for one of these
-- is refused by the old CHECK. The site's write has then already happened, and the screen says the
-- record was not saved.

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unpublish', 'media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore'))
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);
