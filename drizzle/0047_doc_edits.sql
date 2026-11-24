-- One table for every change an AI made in a Google Doc. doc_changes (suggestions and comments) and doc_actions
-- (writes, decisions, undos) held the same columns and were merged back together in code under fake c and a ids.
-- Rows are copied oldest first, so the new ids keep the order. revision_id, undoes and undoes_table were written and
-- never read (a row's undone_at is the one link that is read). Actions had no label in the Doc, so labeled starts
-- at 1 for them. The old tables are no longer read or written; dropping them waits for the Owner's yes.
CREATE TABLE IF NOT EXISTS doc_edits (
  id INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  model TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('suggest', 'comment', 'reply', 'resolve', 'reopen', 'write', 'accept', 'reject', 'withdraw', 'undo')),
  reason TEXT NOT NULL DEFAULT '',
  change TEXT NOT NULL,
  google_ids TEXT NOT NULL DEFAULT '[]',
  labeled INTEGER NOT NULL DEFAULT 1,
  before_text TEXT,
  undone_at TEXT,
  emailed_at TEXT,
  email_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS doc_edits_file ON doc_edits (file_id, created_at);

INSERT INTO doc_edits (file_id, person_id, client, model, kind, reason, change, google_ids, labeled, before_text, undone_at, emailed_at, email_error, created_at)
SELECT file_id, person_id, client, model, kind, reason, change, google_ids, labeled, before_text, undone_at, emailed_at, email_error, created_at FROM (
  SELECT file_id, person_id, client, model, mode AS kind, reason, change, google_ids, labeled, NULL AS before_text, undone_at, NULL AS emailed_at, NULL AS email_error, created_at, id AS old_id, 0 AS src FROM doc_changes
  UNION ALL
  SELECT file_id, person_id, client, model, action, reason, change, google_ids, 1, before_text, undone_at, emailed_at, email_error, created_at, id, 1 FROM doc_actions
) ORDER BY created_at, src, old_id;
