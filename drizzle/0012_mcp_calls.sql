-- The MCP call log (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.4): one row for every tool call
-- through the AI door, written after the call returns. Who called (the person, the AI client), the
-- tool, the arguments as sent, and the result: ok or refused, and what the client was told.
--
-- Append-only. Two triggers refuse every UPDATE and DELETE, so a row once written stays as written;
-- nothing in Carrel edits or prunes it. Each trigger is on one line, so the harness's statement
-- splitter (test/harness/seed.ts) keeps it whole. A row names the person by id and email as text, with no
-- foreign key, so removing a person never rewrites or blocks the record of what their sessions did.
--
-- Long arguments are cut before they are stored (a draft's whole source is up to 500,000 characters);
-- arguments_truncated says when that happened. This migration is CREATE only, so it can be applied
-- before the code that writes it. Until it is applied, every call still runs and the failed log write
-- is reported to Workers Logs.

CREATE TABLE mcp_calls (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL,
  caller TEXT NOT NULL,
  client TEXT NOT NULL,
  tool TEXT NOT NULL,
  arguments TEXT NOT NULL,
  arguments_truncated INTEGER NOT NULL DEFAULT 0 CHECK (arguments_truncated IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused')),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX mcp_calls_person ON mcp_calls (person_id, created_at);

CREATE TRIGGER mcp_calls_no_update BEFORE UPDATE ON mcp_calls BEGIN SELECT RAISE(ABORT, 'mcp_calls is append-only'); END;

CREATE TRIGGER mcp_calls_no_delete BEFORE DELETE ON mcp_calls BEGIN SELECT RAISE(ABORT, 'mcp_calls is append-only'); END;
