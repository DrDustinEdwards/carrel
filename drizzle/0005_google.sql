-- Stage 6: Google (design decision 6). A service account reads the manuscripts folder's metadata and
-- Search Console; Dustin's own OAuth grants only drive.file, for Send to Docs and Import. Manuscript
-- text never enters Carrel: the index holds metadata, and search asks Drive each time.

-- The service account keys Carrel has used, by key id, so the health check can report a key's age.
-- A key file carries no creation date, so age counts from the first time Carrel saw the key.
CREATE TABLE google_keys_seen (
  private_key_id TEXT PRIMARY KEY,
  client_email TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Dustin's drive.file grant: the refresh token, encrypted with AES-GCM under the secret
-- GOOGLE_TOKEN_KEY, so a copy of the database alone cannot use it.
CREATE TABLE google_tokens (
  person_id INTEGER PRIMARY KEY REFERENCES people (id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  iv TEXT NOT NULL,
  scope TEXT NOT NULL,
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error TEXT
);

-- One-use state values for the OAuth round trip, so a callback Carrel did not start is refused.
CREATE TABLE google_oauth_states (
  state TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The manuscripts folder's files, as Drive describes them. Metadata only: no text.
CREATE TABLE manuscripts (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  web_view_link TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  -- Owners and the last person to change it, the nearest Drive metadata comes to coauthors.
  people TEXT NOT NULL DEFAULT '[]',
  created_time TEXT,
  modified_time TEXT,
  synced_at TEXT NOT NULL
);

-- Docs Carrel created from a post (Send to Docs), so Import knows where to read back from.
CREATE TABLE sent_docs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  doc_url TEXT NOT NULL,
  -- The post's frontmatter, kept here rather than sent: Docs would mangle it, and Import puts it back.
  frontmatter TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX sent_docs_item ON sent_docs (project_id, item_id, created_at);

-- Search Console per page for a site, over the last 28 days of data, refreshed at most daily.
CREATE TABLE search_console_pages (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  page TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (project_id, page)
);
