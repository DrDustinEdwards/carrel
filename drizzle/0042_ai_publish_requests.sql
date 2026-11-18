-- An AI session's ask to publish that waits for the Owner's click in Desk (the publishing security review, finding 1,
-- Dustin's ruling of 2026-11-18): an AI draft's text, a transcript draft, or a post that was never published. The ask
-- names the version it was made against, so a newer edit on the site is never put live unseen. decided_at stays null
-- until the person who asked presses Publish or Decline.
CREATE TABLE ai_publish_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  client TEXT NOT NULL,
  expected_version TEXT NOT NULL,
  ai_draft_id INTEGER,
  transcript_draft_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at TEXT,
  outcome TEXT CHECK (outcome IN ('published', 'declined')),
  change_id TEXT
);
CREATE INDEX ai_publish_requests_item ON ai_publish_requests (project_id, item_id);
