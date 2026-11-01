-- BioScience Writers is the seventh site, reached at /api/carrel/v1 on its own Worker for its media library: its pages are
-- code in its own repository, so it lists no items. The Owner holds it; nobody else until it is shared, as in 0014.
INSERT INTO projects (slug, name, site) VALUES ('bsw', 'BioScience Writers', 'bsw')
  ON CONFLICT (slug) DO NOTHING;
