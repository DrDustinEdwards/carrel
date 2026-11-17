-- The tabs Carrel made in a Google Sheet (the Docs plan, slice 9): the only tabs an AI may write cells on, so a write
-- never lands over Dustin's own data. The tab's id is Carrel's own choice at creation, and the title is the one asked for.
CREATE TABLE sheet_tabs (
  file_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  client TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (file_id, sheet_id)
);
