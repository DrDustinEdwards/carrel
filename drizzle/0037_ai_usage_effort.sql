-- The effort each API call ran at (output_config.effort), so the AI engine page splits a job's spend by effort. Null on
-- calls made before it was recorded, and on calls another service metered (the site's picture suggester).
ALTER TABLE ai_usage ADD COLUMN effort TEXT;
