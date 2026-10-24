-- The voice pack of each site project (app/lib/voice.server.ts): what an AI session reads before it
-- drafts a post, so the draft is written from the author's own published posts and not from a model's
-- habits. The profile and excerpts are rebuilt from the published posts; the guide and the two word
-- lists are the Owner's, edited on the project's Voice page.
CREATE TABLE voice_packs (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  guide TEXT NOT NULL DEFAULT '',
  -- JSON arrays of strings: phrases flagged on top of the shared check's lists, and words allowed back out of every list.
  phrases TEXT NOT NULL DEFAULT '[]',
  allow TEXT NOT NULL DEFAULT '[]',
  -- JSON: the shared check's Profile of the published posts, null until there are enough of them.
  profile TEXT,
  excerpts TEXT NOT NULL DEFAULT '[]',
  posts INTEGER NOT NULL DEFAULT 0,
  built_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- What the author cuts from AI drafts before publishing: a word or two-word phrase the latest AI draft
-- of a post used and the published post does not. Seen in three posts and never kept in one, it is
-- offered on the Voice page for the phrase list; the Owner adds it or sets it aside.
CREATE TABLE voice_cuts (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  phrase TEXT NOT NULL,
  -- JSON array of the item ids it was cut from, each counted once.
  items TEXT NOT NULL DEFAULT '[]',
  kept INTEGER NOT NULL DEFAULT 0,
  set_aside INTEGER NOT NULL DEFAULT 0,
  last_cut_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, phrase)
);
