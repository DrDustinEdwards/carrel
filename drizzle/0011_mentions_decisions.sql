-- Webmention decisions in the authorship record (job_43166f1bbe3a). Approving, rejecting or deleting a
-- mention, and sweeping the expired ones, each write one row here when the site carried the action
-- out: who (the person, and the AI client if one ever does it), which project, which mention (the
-- site's id for it), the status it had and the status it has, and the change id Carrel sent the site,
-- so this record joins the site's own history.
--
-- This is a table of its own, and the changes table is not rebuilt: changes holds posts and files,
-- and a mention is neither. A rebuild of changes for a second reason in the same release would also
-- need the other release's action list. This migration is CREATE TABLE only, so it can be applied
-- before or after any other migration.
--
-- mention_id is empty for a sweep, which is about every mention past its retention window and not
-- one of them. status_after is empty for a delete, and both statuses for a sweep.
--
-- Apply this before deploying the code that decides mentions: until it is applied, the site's
-- decision still happens and the screen says the record of it could not be saved.

CREATE TABLE mention_decisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  mention_id TEXT,
  person_id INTEGER NOT NULL REFERENCES people (id),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'delete', 'sweep')),
  status_before TEXT CHECK (status_before IS NULL OR status_before IN ('unverified', 'pending', 'approved', 'rejected', 'failed')),
  status_after TEXT CHECK (status_after IS NULL OR status_after IN ('unverified', 'pending', 'approved', 'rejected', 'failed')),
  change_id TEXT NOT NULL UNIQUE,
  client TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (mention_id IS NOT NULL OR action = 'sweep'),
  CHECK (status_after IS NOT NULL OR action IN ('delete', 'sweep'))
);

CREATE INDEX mention_decisions_project ON mention_decisions (project_id, created_at);
