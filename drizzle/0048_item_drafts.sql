-- One table for the whole texts an AI session saves beside the site's: ai_drafts (a post's or a book file's text) and
-- transcript_drafts (an episode's WebVTT) shared every column but the text and the version it was written from.
-- Transcript drafts keep their ids because transcript_changes.draft_id names them; text drafts take the ids after.
-- The old tables are no longer read or written; dropping them waits for the Owner's yes.
CREATE TABLE IF NOT EXISTS item_drafts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'transcript')),
  body TEXT NOT NULL,
  base_version TEXT,
  note TEXT NOT NULL DEFAULT '',
  sources TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS item_drafts_item ON item_drafts (project_id, item_id, created_at);

INSERT INTO item_drafts (id, project_id, item_id, person_id, client, kind, body, base_version, note, sources, created_at)
SELECT id, project_id, item_id, person_id, client, 'transcript', transcript, base_transcript_version, note, NULL, created_at
FROM transcript_drafts ORDER BY id;

INSERT INTO item_drafts (project_id, item_id, person_id, client, kind, body, base_version, note, sources, created_at)
SELECT project_id, item_id, person_id, client, 'text', source, base_version, note, sources, created_at
FROM ai_drafts ORDER BY id;
