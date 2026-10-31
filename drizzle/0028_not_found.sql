-- Carrel's own 404s, per path, referring host and UTC day (site-runtime's ./not-found, NOT_FOUND_SQL), counted by
-- workers/app.ts on both doors and pruned to 90 days by the nightly cron. Only the path (never its query) and the
-- referring host are kept. Additive: one new table and its unique index.

CREATE TABLE IF NOT EXISTS page_404_daily (
  id TEXT PRIMARY KEY NOT NULL,
  day INTEGER NOT NULL,
  path TEXT NOT NULL,
  referrer_host TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'page',
  hit_count INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS page_404_daily_day_path_referrer_uq ON page_404_daily (day, path, referrer_host);
