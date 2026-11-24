-- An AI publish's email to Dustin is recorded on the change itself. ai_publications repeated the change's project,
-- item, person, client, version and time, and only emailed_at and email_error were new. An AI publish is a publish
-- change that has a client, so older ones need no backfill. The old table is no longer read or written; dropping it
-- waits for the Owner's yes.
ALTER TABLE changes ADD COLUMN emailed_at TEXT;
ALTER TABLE changes ADD COLUMN email_error TEXT;
