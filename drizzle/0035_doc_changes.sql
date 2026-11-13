-- The record of every change an AI makes in a Google Doc through Carrel (the Docs plan, slice 2). Additive: one new table.
--
-- doc_changes: one row per call that changed a Doc: a batch of suggested edits, a comment, a reply, or a resolve
-- or reopen. `client` is the AI that asked (the MCP client's name) and `model` the model it reported, if it did.
-- `change` is the exact change as JSON (the edits as asked, with the positions Carrel resolved them to) so one
-- can be taken back later; `google_ids` are the suggestion or comment ids Google returned; `labeled` is 1 once
-- the label (which AI, and why) is on the suggestion or comment in the Doc itself.

CREATE TABLE IF NOT EXISTS doc_changes (
  id INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  model TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('suggest', 'comment', 'reply', 'resolve', 'reopen')),
  reason TEXT NOT NULL DEFAULT '',
  change TEXT NOT NULL,
  google_ids TEXT NOT NULL DEFAULT '[]',
  labeled INTEGER NOT NULL DEFAULT 0,
  revision_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS doc_changes_file ON doc_changes (file_id, created_at);
