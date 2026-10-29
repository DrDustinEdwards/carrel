-- The last sync of Cloudflare Access (app/lib/access-sync.server.ts), so the People page can say
-- whether Access is in step or waiting for Cloudflare. One row, replaced by every sync: Capsid's
-- audit_log keeps each call, so Carrel keeps only the latest. Additive: one new table.

CREATE TABLE access_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  synced_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  -- Why the group was not written, in Capsid's or Cloudflare's words; null when ok.
  refusal TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0
);
