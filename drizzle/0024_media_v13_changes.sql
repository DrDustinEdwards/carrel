-- The media writes of site-api v0.13 in the authorship record (2026-10-29).
--
-- The authorship record gains five actions, each a file's media id with its versions where the site
-- gives them: 'media-import' (a file fetched from a web address), 'media-credit' (credit, license,
-- source and license end), 'media-transform' (a turn or a mirror), 'media-revert' (the file's bytes
-- back to an earlier version) and 'media-resize' (shrunk to the site's size).
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt as migrations 0007, 0009,
-- 0010 and 0021 did: the same columns, the lists widened. Nothing references it by foreign key
-- (change_contributors, migration 0022, keeps the change id without one), so the rebuild is a copy and
-- a rename. Apply this before deploying the code that writes: until then, the record of one of the new
-- actions is refused by the old CHECK after the site has already done it (the screen says the record
-- was not saved).

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unschedule', 'unpublish', 'media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace', 'media-import', 'media-credit', 'media-transform', 'media-revert', 'media-resize')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace', 'media-import', 'media-credit', 'media-transform', 'media-revert', 'media-resize'))
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);
