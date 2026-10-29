-- The Author role, scheduled updates to live posts and the new media writes (2026-10-29).
--
-- An Author (Dustin's ruling of 2026-10-29) publishes and unpublishes the posts they wrote on the
-- projects they are granted, and nothing else an Owner does. A post's author is read from the
-- authorship record below (the person whose save created it), so the role needs no new column, only a
-- membership role the CHECK allows.
--
-- The authorship record gains four actions: 'unschedule' (a scheduled update to a live post was
-- cancelled, the live post left as it was), and 'media-focus', 'media-caption' and 'media-replace' (a
-- file's focal point, its caption, and its bytes replaced under the same id and address).
--
-- SQLite cannot change a CHECK constraint in place, so both tables are rebuilt as migrations 0007,
-- 0009 and 0010 did: the same columns, the lists widened. Nothing references either table by foreign
-- key, so each rebuild is a copy and a rename. Apply this before deploying the code that writes: until
-- then, granting Author is refused, and the record of one of the new actions is refused by the old
-- CHECK after the site has already done it (the screen says the record was not saved).

CREATE TABLE project_members_new (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader', 'editor', 'author')),
  PRIMARY KEY (project_id, person_id)
);

INSERT INTO project_members_new (project_id, person_id, role)
  SELECT project_id, person_id, role FROM project_members;

DROP TABLE project_members;

ALTER TABLE project_members_new RENAME TO project_members;

CREATE INDEX project_members_person ON project_members (person_id);

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unschedule', 'unpublish', 'media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace'))
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);

-- When the update waiting on a live post goes live (site-api v0.10.0, scheduledUpdate.publishAt), so
-- the Posts list shows it. Null when nothing waits, and on a site without scheduled updates.
ALTER TABLE site_items ADD COLUMN update_at TEXT;
