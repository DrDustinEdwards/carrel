-- Who made each preview link of a post (the publishing security review, finding 3): a link shows the post to anyone
-- who holds it, so making one is a publish, and it is recorded as one is. The changes table's action list cannot grow
-- after 0028, so the record is its own table. change_id is the id the site was sent with the link.
CREATE TABLE preview_link_records (
  change_id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
