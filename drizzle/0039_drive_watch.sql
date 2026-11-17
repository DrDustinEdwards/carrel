-- Awareness (the Docs plan, slice 7). `waiting` is how many suggestions an AI laid in the Doc through Carrel are still
-- open, counted when the Doc changes; Home lists the Docs where some wait. drive_watch is the one channel on which
-- Google tells Carrel that a file the service account can see changed (Drive's changes.watch, renewed before its week
-- is up), so the index refreshes then and not only every quarter hour.
ALTER TABLE manuscripts ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0;
CREATE TABLE drive_watch (
  id TEXT PRIMARY KEY NOT NULL,
  resource_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refreshed_at TEXT
);
