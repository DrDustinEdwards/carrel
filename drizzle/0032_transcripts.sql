-- Episode transcripts written through site-api v0.36.0 (PUT /content/:id/transcript). Additive: two new tables.
--
-- transcript_drafts: a whole WebVTT transcript saved beside the site's, never over it: an AI session's fix of a
-- machine-made transcript, or the transcript a publish replaced, kept so it can be put back. A draft names the
-- transcriptVersion it was written from, and is published only from that version.
--
-- transcript_changes: the authorship record of each transcript a person or an AI session put live. It is apart from
-- changes because a transcript has its own version and the item's version does not move (and because widening the
-- CHECK on changes is a table rebuild, which the deploy refuses).

CREATE TABLE IF NOT EXISTS transcript_drafts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  transcript TEXT NOT NULL,
  base_transcript_version TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS transcript_drafts_item ON transcript_drafts (project_id, item_id, created_at);

CREATE TABLE IF NOT EXISTS transcript_changes (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  client TEXT,
  draft_id INTEGER,
  version_before TEXT,
  version_after TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS transcript_changes_item ON transcript_changes (project_id, item_id, created_at);
