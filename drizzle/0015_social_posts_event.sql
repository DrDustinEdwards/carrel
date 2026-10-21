-- Saving a post looks up the event's open posts by event_id (queue.server.ts), and the queue joins
-- posts to events on it; without this index both scan social_posts (EXPLAIN QUERY PLAN: SCAN).
CREATE INDEX social_posts_event ON social_posts (event_id);
PRAGMA optimize;
