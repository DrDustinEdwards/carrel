-- txasm (its two site pages) and julieedwards.info (its sections) are the fifth and sixth sites, each
-- reached at /api/carrel/v1 on its own Worker. The Owner holds them; nobody else until they are shared, as in 0014.
INSERT INTO projects (slug, name, site) VALUES ('txasm', 'Texas Branch ASM', 'txasm')
  ON CONFLICT (slug) DO NOTHING;
INSERT INTO projects (slug, name, site) VALUES ('julieedwards', 'julieedwards.info', 'julieedwards')
  ON CONFLICT (slug) DO NOTHING;
