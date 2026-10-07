-- Deleting a post in the authorship record. A delete that a site carried out writes one row in
-- changes, like every other write: who (the person), which project, which post (item_id), the version
-- that was deleted (version_before), and the change id Carrel sent the site, so this record joins the
-- site's own history. A deleted post has no version afterwards, so version_after is empty for it.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt exactly as migration 0007
-- did: the same columns, 'content-delete' added to the action list, and version_after optional for
-- that action as it already is for the media actions. Every other content write still requires it.
-- Nothing references changes by foreign key, so the rebuild is a copy and a rename.
--
-- Apply this before deploying the code that deletes: until it is applied, the insert for a delete is
-- refused by the old CHECK and the screen says the post was deleted but the record was not saved.

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unpublish', 'media-upload', 'media-delete', 'content-delete')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete', 'content-delete'))
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);
