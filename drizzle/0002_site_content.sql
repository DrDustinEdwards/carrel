-- Stage 2: a project can be a site reached through site-api, with an index of its content for the
-- one view, autosaved drafts, and a record of every write Carrel sends.

-- The site registry key (app/lib/sites.server.ts) for a project that is a site; null for others.
ALTER TABLE projects ADD COLUMN site TEXT;
CREATE UNIQUE INDEX projects_site ON projects (site) WHERE site IS NOT NULL;

-- dustinedwards.info is the first site. The Owner holds it; nobody else until it is shared.
INSERT INTO projects (slug, name, site) VALUES ('dustinedwards-info', 'dustinedwards.info', 'dustinedwards')
  ON CONFLICT (slug) DO NOTHING;

-- What the site reported for each item, refreshed on save and by the 15-minute cron. A cache only:
-- the site is the authority, so a stale row is corrected by the next refresh, never written back.
CREATE TABLE site_items (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'published')),
  path TEXT,
  publish_at TEXT,
  published_at TEXT,
  updated_at TEXT,
  -- The updated_at the body below was read at; a mismatch means the body needs fetching again.
  body_updated_at TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id)
);

-- Search over title and body. Written only by app/lib/index.server.ts, in step with site_items.
CREATE VIRTUAL TABLE site_items_fts USING fts5 (
  project_id UNINDEXED,
  item_id UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);

-- Autosave: one working copy per person per item. base_version is the site version the draft was
-- started from (null for an item not yet on the site), so a save carries it as expectedVersion.
CREATE TABLE drafts (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  base_version TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id, person_id)
);

-- Every write Carrel sent to a site and the site accepted. The change id is also in the site's own
-- history, so the two records join. The seed of the authorship record (stage 4).
CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('save', 'publish', 'schedule', 'unpublish')),
  version_before TEXT,
  version_after TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX changes_item ON changes (project_id, item_id, created_at);
