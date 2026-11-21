-- contract: the emailed-click publish flow is gone (carrel #542: an Owner AI session publishes at once on Dustin's
-- approval in chat), so ai_publish_requests, which held its pending asks, is unused. Nothing reads or writes it.
-- Run by hand after the D1 Time Travel bookmark is read: npm run db:migrate:remote.
DROP TABLE ai_publish_requests;
