-- Moves in the binder and the corkboard (job_b4555715afcf). Reordering a book renames its numbered
-- files, every rename in one commit. This keeps one row per renamed file, so a file's history can
-- follow it back across its old paths (GitHub's history of a path stops at a rename), and so the
-- authorship record can say who moved what. change_id is the Carrel-Change trailer of the commit.
--
-- Additive only: one new table. It can be applied before the code.

CREATE TABLE book_moves (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX book_moves_to ON book_moves (project_id, to_path);
