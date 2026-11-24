-- An AI publish's email to Dustin is recorded on the change itself. ai_publications repeated the change's project,
-- item, person, client, version and time, and only emailed_at and email_error were new. A row with neither column
-- set is not an AI publish. The old table is no longer read or written; dropping it waits for the Owner's yes.
ALTER TABLE changes ADD COLUMN emailed_at TEXT;
ALTER TABLE changes ADD COLUMN email_error TEXT;

UPDATE changes
SET emailed_at = (SELECT emailed_at FROM ai_publications WHERE ai_publications.change_id = changes.id),
    email_error = (SELECT CASE WHEN emailed_at IS NULL THEN COALESCE(email_error, 'not sent') END
                   FROM ai_publications WHERE ai_publications.change_id = changes.id)
WHERE id IN (SELECT change_id FROM ai_publications);
