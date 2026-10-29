-- Live co-editing (Dustin's ruling of 2026-10-10, point 3 and build step 10): several people in one
-- file at once, through a room per file (workers/doc-room.ts, a Durable Object on y-partyserver).
--
-- rooms: each file's shared working copy as Markdown, written by its room after every change. The
-- room's own storage holds the live copy; this mirror is what the nightly D1 backup carries, and what
-- a page shows before its editor connects. It replaces each person's private draft (drafts) for a
-- file with a room; drafts stays for the text people had before live editing began.
--
-- comments: threads on a file. A thread's first comment has an anchor (where it sits, as Yjs relative
-- positions) and the words it was on; a reply names the first comment and has neither. Deleting is a
-- mark, so the authorship of a thread is never rewritten.
--
-- change_contributors: everyone whose changes are in the text one save wrote, beside the person who
-- pressed Save (changes.person_id). No foreign key on change_id: changes is rebuilt by migrations
-- that widen its CHECK, as 0021 did.
--
-- Additive: three new tables. Apply before deploying the code that writes them.

CREATE TABLE rooms (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  source TEXT NOT NULL,
  base_version TEXT,
  saved_source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  parent_id TEXT,
  person_id INTEGER NOT NULL REFERENCES people (id),
  body TEXT NOT NULL,
  anchor TEXT,
  quote TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  edited_at TEXT,
  resolved_at TEXT,
  resolved_by INTEGER,
  deleted_at TEXT
);

CREATE INDEX comments_item ON comments (project_id, item_id, created_at);

CREATE TABLE change_contributors (
  change_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  PRIMARY KEY (change_id, person_id)
);
