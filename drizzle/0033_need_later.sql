-- Later on Home's rows. Additive: one new table.
--
-- need_later: a row of Home's "Needs you" that a person set aside. It stays off Home and out of the header's
-- count until `until` (the next morning in the person's time zone), or sooner when the need changes: the row is
-- kept with the title it had, and a need whose title now reads differently (another draft, a post now overdue)
-- shows again. One row per person and need; setting it aside again replaces it.

CREATE TABLE IF NOT EXISTS need_later (
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  need_id TEXT NOT NULL,
  title TEXT NOT NULL,
  until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (person_id, need_id)
);
