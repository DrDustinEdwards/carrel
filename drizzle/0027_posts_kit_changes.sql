-- The posts and mentions lists on site-api v0.17.0's content kit (2026-10-31).
--
-- The authorship record gains three actions, each a post's id with its versions: 'content-trash' (to
-- the site's Trash, a live post taken off the site first), 'content-restore' (back from it, as a draft)
-- and 'content-rename' (moved to a new id, its old address redirecting). A rename's row is under the
-- new id and keeps the old one in renamed_from, so the post's Author follows it (content.server.ts,
-- itemAuthor). The mention decisions gain 'reset', a decision taken back to waiting (site-api v0.6.0).
--
-- SQLite cannot change a CHECK constraint in place, so both tables are rebuilt as migrations 0021 and
-- 0024 did: the same columns, the lists widened, and changes gains renamed_from. Nothing references
-- either table by foreign key, so each rebuild is a copy and a rename. Apply this before deploying the
-- code that writes: until then, the record of one of the new actions is refused by the old CHECK after
-- the site has already done it (the list says the record could not be saved).

CREATE TABLE changes_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unschedule', 'unpublish', 'media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace', 'media-import', 'media-credit', 'media-transform', 'media-revert', 'media-resize', 'content-trash', 'content-restore', 'content-rename')),
  version_before TEXT,
  version_after TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client TEXT,
  renamed_from TEXT,
  CHECK (version_after IS NOT NULL OR action IN ('media-upload', 'media-delete', 'content-delete', 'media-alt', 'media-tags', 'media-trash', 'media-restore', 'media-focus', 'media-caption', 'media-replace', 'media-import', 'media-credit', 'media-transform', 'media-revert', 'media-resize')),
  CHECK (renamed_from IS NULL OR action = 'content-rename')
);

INSERT INTO changes_new (id, project_id, item_id, person_id, action, version_before, version_after, created_at, client)
  SELECT id, project_id, item_id, person_id, action, version_before, version_after, created_at, client FROM changes;

DROP TABLE changes;

ALTER TABLE changes_new RENAME TO changes;

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);

CREATE TABLE mention_decisions_new (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  mention_id TEXT,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'reset', 'delete', 'sweep')),
  status_before TEXT CHECK (status_before IS NULL OR status_before IN ('unverified', 'pending', 'approved', 'rejected', 'failed')),
  status_after TEXT CHECK (status_after IS NULL OR status_after IN ('unverified', 'pending', 'approved', 'rejected', 'failed')),
  change_id TEXT NOT NULL UNIQUE,
  client TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (mention_id IS NOT NULL OR action = 'sweep'),
  CHECK (status_after IS NOT NULL OR action IN ('delete', 'sweep'))
);

INSERT INTO mention_decisions_new (id, project_id, mention_id, person_id, action, status_before, status_after, change_id, client, created_at)
  SELECT id, project_id, mention_id, person_id, action, status_before, status_after, change_id, client, created_at FROM mention_decisions;

DROP TABLE mention_decisions;

ALTER TABLE mention_decisions_new RENAME TO mention_decisions;

CREATE INDEX mention_decisions_project ON mention_decisions (project_id, created_at);
