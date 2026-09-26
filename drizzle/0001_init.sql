-- Stage 1: people, projects, per-project roles, and the health check's last known state.

-- A person Cloudflare Access admits is still refused unless a row here names their email.
-- The Owner (Dustin) is a flag on the person, not a membership: the Owner holds every project.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- At most one Owner, so a shared user can never be granted the Owner's powers by a second flag.
CREATE UNIQUE INDEX people_one_owner ON people (is_owner) WHERE is_owner = 1;

CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Shared access. Only Reader and Editor are grantable; Owner is not a membership role.
CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader', 'editor')),
  PRIMARY KEY (project_id, person_id)
);

CREATE INDEX project_members_person ON project_members (person_id);

-- One row per health check. An email goes out only when a check's state changes.
CREATE TABLE health_state (
  check_name TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  detail TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
