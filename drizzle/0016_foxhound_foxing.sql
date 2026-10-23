-- Foxhound (its blog) and Foxing (its Journal) are the third and fourth sites, each reached at
-- /api/carrel/v1 on its own Worker. The Owner holds them; nobody else until they are shared, as in 0014.
INSERT INTO projects (slug, name, site) VALUES ('foxhound', 'Foxhound', 'foxhound')
  ON CONFLICT (slug) DO NOTHING;
INSERT INTO projects (slug, name, site) VALUES ('foxing', 'Foxing', 'foxing')
  ON CONFLICT (slug) DO NOTHING;
