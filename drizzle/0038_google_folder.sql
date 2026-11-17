-- The folder Carrel makes in Dustin's Drive with his drive.file grant (the Docs plan, slice 4): new Docs go in it, and
-- it is shared with the service account as an editor so the Docs tools reach them. Null until Carrel first creates a
-- Doc. Carrel's index walks it beside the Manuscripts folder.
ALTER TABLE google_tokens ADD COLUMN folder_id TEXT;
