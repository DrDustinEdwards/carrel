-- A book file brought in from a Google Doc (the Docs plan, slice 8): which Doc, who brought it, the Google
-- suggestions that came in as Carrel suggestions (a JSON array of their ids), and the Doc's revision and the time
-- when the file and the Doc last met, so a send back lays in only what changed and comments only on new threads.
CREATE TABLE doc_links (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  brought TEXT NOT NULL DEFAULT '[]',
  revision_id TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id)
);
