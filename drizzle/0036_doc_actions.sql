-- Review, direct write, undo and locks in Google Docs (the Docs plan, slice 3). Additive: two new tables and a column.
--
-- doc_actions: one row per change made to a Doc's text on Dustin's own ask, as opposed to doc_changes' suggestions and
-- comments, which he decides on in Docs: a direct write, an accept, a reject, a withdrawn suggestion, or an undo.
-- `client` is the AI that asked and `model` the model it reported. For a write, `change` holds each edit's text before
-- and after with the words around it, so undo can find the passage again, and `before_text` is the whole Doc's text
-- as it stood before (as carrel_read_doc shows it), for a compare when the passage has moved. `undoes` names the doc_changes or doc_actions row an undo took back (`undoes_table`).
-- `emailed_at` and `email_error` record the email the Docs email setting sends for a write.
--
-- doc_locks: Dustin's per-Doc lock, set in Desk: 'suggest-only' refuses direct writes and accepts for every AI,
-- 'no-ai' refuses every Docs tool on that Doc.
--
-- doc_changes.undone_at: when an undo took that suggestion or comment back.

CREATE TABLE IF NOT EXISTS doc_actions (
  id INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  model TEXT,
  action TEXT NOT NULL CHECK (action IN ('write', 'accept', 'reject', 'withdraw', 'undo')),
  reason TEXT NOT NULL DEFAULT '',
  change TEXT NOT NULL,
  google_ids TEXT NOT NULL DEFAULT '[]',
  revision_id TEXT,
  before_text TEXT,
  undoes INTEGER,
  undoes_table TEXT CHECK (undoes_table IN ('doc_changes', 'doc_actions')),
  undone_at TEXT,
  emailed_at TEXT,
  email_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS doc_actions_file ON doc_actions (file_id, created_at);

CREATE TABLE IF NOT EXISTS doc_locks (
  file_id TEXT PRIMARY KEY,
  lock TEXT NOT NULL CHECK (lock IN ('suggest-only', 'no-ai')),
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

ALTER TABLE doc_changes ADD COLUMN undone_at TEXT;
