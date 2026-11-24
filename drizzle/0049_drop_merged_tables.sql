-- contract: Dustin approved dropping the four tables the merges replaced (2026-11-24 database audit): doc_changes and
-- doc_actions are doc_edits (0047, 6 rows copied), ai_drafts and transcript_drafts are item_drafts (0048, 206 rows
-- copied). Nothing reads or writes them.
-- Run by hand after the D1 Time Travel bookmark is read: npm run db:migrate:remote.
DROP TABLE doc_changes;
DROP TABLE doc_actions;
DROP TABLE ai_drafts;
DROP TABLE transcript_drafts;
