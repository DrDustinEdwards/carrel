-- The author's own writing, pasted on the Voice page (voice.server.ts): pieces split by a line holding
-- only ---. When there is any, the excerpts come from it and not from the published posts, which may
-- not be the author's own words.
ALTER TABLE voice_packs ADD COLUMN own TEXT NOT NULL DEFAULT '';
