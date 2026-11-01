-- site-runtime's fireOnce duplicate guard for the social routine (./routine, ROUTINE_FIRES_SQL; R2): one record per
-- fire, reserved before the POST with an atomic insert, so a retry of a run never starts a second session.
-- Additive: one new table.

CREATE TABLE IF NOT EXISTS routine_fires (key TEXT PRIMARY KEY, value TEXT NOT NULL);
