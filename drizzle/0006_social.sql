-- Stage 9: social (design decision 5 and section 5, "Social"). Posts come only from real events (a
-- piece going live), are drafted ahead by the session that finished the piece, or by a Claude Code
-- routine Carrel fires, or last of all by a template, and are sent with no AI at runtime. There is
-- no reply or direct-message table, because there is no reply or direct-message code.
--
-- Carried over from legacy Recova's social tables (social_config, social_posts, and the cooldown its
-- topic log kept): the per-account switches and caps, the record of every post, and a gap between
-- posts. Its lead, keyword and reply tables are not carried over.

-- One row per account Carrel may post to. Credentials are secrets named from the key, never here.
CREATE TABLE social_accounts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z0-9]*' AND key NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('bluesky', 'x')),
  -- The personal account is drafted and approved post by post, always (design section 5).
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'brand')),
  handle TEXT NOT NULL,
  -- The project whose publications this account announces.
  project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL,
  mode TEXT NOT NULL DEFAULT 'approval' CHECK (mode IN ('approval', 'auto')),
  -- The off switch. Every account starts off.
  enabled INTEGER NOT NULL DEFAULT 0,
  daily_cap INTEGER NOT NULL DEFAULT 3,
  min_gap_minutes INTEGER NOT NULL DEFAULT 60,
  -- X only: the most Carrel may spend on posts in a calendar month, in mills (thousandths of a
  -- dollar, since a post costs 1.5 cents).
  monthly_budget_mills INTEGER NOT NULL DEFAULT 0,
  -- The last-resort post: {title}, {summary} and {link} are filled in.
  template TEXT NOT NULL DEFAULT '',
  voice_guide TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind = 'brand' OR mode = 'approval')
);

-- Each fire of the Claude Code routine, batched across accounts.
CREATE TABLE social_routine_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('batch', 'nightly')),
  requested_at TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fired', 'failed')),
  session_url TEXT,
  error TEXT
);

-- A real event an account may announce: a piece of a project. It exists from the first pre-drafted
-- post; it becomes sendable when the piece is published (published_at).
CREATE TABLE social_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES social_accounts (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  -- waiting: no post yet; routine: the routine was asked; covered: a post exists for it; templated:
  -- the last resort was used; closed: nothing will be posted (the account was off when it went live).
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'routine', 'covered', 'templated', 'closed')),
  routine_run_id INTEGER REFERENCES social_routine_runs (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, project_id, item_id)
);

-- Every post, whatever became of it: the record the design asks for.
CREATE TABLE social_posts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES social_accounts (id) ON DELETE CASCADE,
  -- Posts only from real events: no post without one.
  event_id INTEGER NOT NULL REFERENCES social_events (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('predrafted', 'routine', 'template')),
  status TEXT NOT NULL CHECK (status IN ('drafted', 'held', 'awaiting', 'queued', 'sent', 'by-hand', 'failed', 'rejected')),
  -- What the lint found, as JSON; a post with findings is held.
  lint TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  approved_by INTEGER REFERENCES people (id),
  cost_mills INTEGER NOT NULL DEFAULT 0,
  platform_post_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at TEXT,
  -- Template posts only: when Dustin marked the health alert about it as seen.
  acknowledged_at TEXT
);

CREATE INDEX social_posts_account ON social_posts (account_id, status, sent_at);
