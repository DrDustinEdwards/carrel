-- Media in the authorship record (job_11a70a5353a3). An upload to a site's media library and a delete
-- from it each write one row in changes, like a content write: who (the person, and the AI client when
-- it came through the AI door), which project, which file (item_id holds the site's media id), and
-- the change id Carrel sent the site, so this record joins the site's own history.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt: the same columns, the
-- action list widened, and version_after optional for media rows only (a file has no version), still
-- required for every content write. Nothing references changes by foreign key, so the rebuild is a
-- copy and a rename.

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unpublish', 'media-upload', 'media-delete')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete'))
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);
