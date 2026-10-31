-- Each scheduled job's last start, success and failure (site-runtime's ./cron, CRON_SQL), written by runJobs in
-- workers/app.ts and read by /health's cron check. Epoch milliseconds. Additive: one new table.

CREATE TABLE IF NOT EXISTS cron_runs (
  name TEXT PRIMARY KEY NOT NULL,
  every_minutes INTEGER NOT NULL,
  first_started_at INTEGER,
  last_started_at INTEGER,
  last_ok_at INTEGER,
  last_failed_at INTEGER,
  last_error TEXT
);
