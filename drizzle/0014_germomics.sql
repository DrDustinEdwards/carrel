-- germomics is the second site, reached at /api/carrel/v1 on its own Worker. The Owner holds it;
-- nobody else until it is shared, as with dustinedwards.info in 0002.
INSERT INTO projects (slug, name, site) VALUES ('germomics', 'Germomics', 'germomics')
  ON CONFLICT (slug) DO NOTHING;
