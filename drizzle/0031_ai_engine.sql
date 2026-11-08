-- Which engine does AI work, subscription or API (site-runtime ./ai-engine): one settings row, and one row per API call so
-- the month's spend can be shown and capped. Additive: two new tables.

CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  micros INTEGER NOT NULL,
  prompt_size INTEGER NOT NULL,
  answer_size INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage (created_at);
