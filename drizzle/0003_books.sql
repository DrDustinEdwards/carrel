-- Stage 4: a project can be a book in the novels repository. Words stay in Git; D1 keeps an index
-- of the book's files for the views and the checks, the checks' findings, and the authorship record.

-- The book's folder in the novels repository for a project that is a book; null for others. A
-- project is a site or a book, never both (enforced in app/lib/books.server.ts).
ALTER TABLE projects ADD COLUMN book TEXT;
CREATE UNIQUE INDEX projects_book ON projects (book) WHERE book IS NOT NULL;

-- One row per Markdown file under the book's folder, as Git last had it. A cache: Git is the
-- authority, so a stale row is corrected by the next refresh or save, never written back.
CREATE TABLE book_files (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Relative to the book's folder, such as chapters/01-arrival/01-the-road.md.
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scene', 'character', 'place', 'rule', 'outline', 'book', 'note')),
  -- The Git blob sha, which is also the expected version a save carries.
  sha TEXT NOT NULL,
  source TEXT NOT NULL,
  -- The parsed header or bible entry, as JSON.
  meta TEXT NOT NULL DEFAULT '{}',
  words INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);

-- Files under shared/ in the novels repository that the checks read: Dustin's voice passages and
-- the AI-habits list. Shared by every book.
CREATE TABLE novels_shared (
  path TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  source TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- What the checks on save found. A flag never blocks a save; an open flag blocks export until the
-- Owner fixes the text or dismisses the flag. The fingerprint keeps a dismissal across saves.
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  check_name TEXT NOT NULL,
  message TEXT NOT NULL,
  line INTEGER,
  excerpt TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
  dismissed_by INTEGER REFERENCES people (id),
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, path, fingerprint)
);

CREATE INDEX findings_open ON findings (project_id, status, path);

-- The authorship record (design decision 11): one row per change Carrel committed, with who made it.
-- client names the AI client for changes made through MCP (stage 5); null for a person in the UI.
-- The id is also the Carrel-Change line in the commit message, so the two records join.
CREATE TABLE authorship (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES people (id),
  client TEXT,
  words_added INTEGER NOT NULL,
  words_removed INTEGER NOT NULL,
  version_before TEXT,
  version_after TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX authorship_project ON authorship (project_id, created_at);
