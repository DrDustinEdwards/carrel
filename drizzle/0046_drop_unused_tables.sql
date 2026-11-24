-- contract: Dustin approved dropping four tables nothing reads or writes (2026-11-24 database audit). mcp_sessions and
-- voice_cuts are empty; mcp_calls (111 rows, its triggers refuse DELETE) is the old tool-call log, now the
-- ToolCallLog Durable Object; ai_publications moved onto changes in 0045.
-- Run by hand after the D1 Time Travel bookmark is read: npm run db:migrate:remote.
DROP TABLE mcp_sessions;
DROP TABLE voice_cuts;
DROP TABLE mcp_calls;
DROP TABLE ai_publications;
