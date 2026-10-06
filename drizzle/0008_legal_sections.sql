-- Legal pages (job_d8673816b797, design-legal-pages.md as amended 2026-10-06): the parts every site
-- says alike (who runs the site, Cloudflare hosting, Web Analytics without tracking cookies) are
-- written once here and written into each site's privacy or terms page when that page is published.
-- A site's own facts are fields on its page, so nothing about one site is stored in this table.

CREATE TABLE legal_sections (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*'),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by INTEGER NOT NULL REFERENCES people (id)
);
