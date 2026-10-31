-- Public reports Carrel rewrites on a schedule (2026-10-31). One row per report, its whole JSON body.
--
-- The first is 'conformance': each site's latest site-api conformance result from the health run, served
-- at /reports/conformance.json on the AI door for devkit's shared scoreboard. It holds check names and
-- the site's API address only, never a key or a site's own text.

CREATE TABLE reports (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
