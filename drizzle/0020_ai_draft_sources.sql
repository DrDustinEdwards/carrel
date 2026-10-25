-- The sources an AI draft drew on, as a JSON array of their text: the scan checks the draft's names and numbers
-- against them, and the AI draft page shows them. Null on drafts saved before sources were asked for.
ALTER TABLE ai_drafts ADD COLUMN sources TEXT;
