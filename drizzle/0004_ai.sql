-- Stage 5: AI work through MCP tools in the Worker (design decisions 2 and 7). An AI session is known
-- by the door it came through (the MCP Access application's token), never by email; this records
-- which AI client did what, what reviewers flagged, and every publish an AI session made.

-- A reviewer is another company's AI agent (design B6): it reads and flags through MCP, never writes
-- text or publishes, and never signs in through the browser.
ALTER TABLE people ADD COLUMN is_reviewer INTEGER NOT NULL DEFAULT 0;

-- The AI client a change was made through; null for the browser. The authorship record credits it.
ALTER TABLE changes ADD COLUMN client TEXT;

-- One row per MCP session: who, and the client it named itself at initialize (MCP clientInfo).
CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  client_version TEXT,
  protocol_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Flags on an item, from a check or a reviewer. The same table stage 4 creates for books (0003), with
-- the same definition, so the two migrations apply in either order. For a site item, path is the
-- item id. A flag never blocks a save; an open flag blocks publish.
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  check_name TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER,
  excerpt TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
  dismissed_by INTEGER REFERENCES people (id),
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, path, fingerprint)
);

CREATE INDEX IF NOT EXISTS findings_open ON findings (project_id, status, path);

-- Drafts an AI session saved. Each save is a new row beside the person's own draft, never over it
-- (design: AI never rewrites Dustin's prose unasked); the person decides whether to use one.
CREATE TABLE ai_drafts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  source TEXT NOT NULL,
  base_version TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX ai_drafts_item ON ai_drafts (project_id, item_id, created_at);

-- Every publish an AI session made (decision 2c), and whether its email to Dustin went out. The id
-- is the change id, so this joins the changes table and the site's own history.
CREATE TABLE ai_publications (
  change_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  client TEXT NOT NULL,
  version TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  emailed_at TEXT,
  email_error TEXT
);
