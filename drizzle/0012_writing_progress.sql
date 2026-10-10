-- Writing 1 (job_50786e609b88, ruling carrel/rulings/writing-tools-2026-10-10.md points 6 and 8):
-- each project's status list, each person's writing goal, and the typed-word count of every save.
--
-- status_labels holds a project's own list, in order, each label with one of Capsomer's eight
-- series colors (1 to 8). A project with no rows uses the starting list for its kind; the first
-- edit writes the whole list.
--
-- writing_goals is one row per person per project: a daily target set by hand, or a pace worked
-- out from the deadline in the project file, over the weekdays chosen (0 is Sunday). allow_negative
-- lets deletions take a day below zero, which they do not by default.
--
-- untyped_words is the running count of words that reached a file without being typed (pasted,
-- dropped, or an AI draft taken as the working draft) since that person's last save of it. A save
-- subtracts it from the words added and clears it.
--
-- authorship.words_typed is what a save counts toward the day. Rows from before this migration, and
-- saves made by an AI client, leave it empty and count for nothing.
--
-- Additive only: two tables, one more table, one nullable column. It can be applied before the code.

CREATE TABLE status_labels (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  color INTEGER NOT NULL CHECK (color BETWEEN 1 AND 8),
  PRIMARY KEY (project_id, position)
);

CREATE TABLE writing_goals (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'daily' CHECK (mode IN ('daily', 'deadline')),
  daily_target INTEGER,
  writing_days TEXT NOT NULL DEFAULT '0123456',
  allow_negative INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, person_id)
);

CREATE TABLE untyped_words (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, person_id, path)
);

ALTER TABLE authorship ADD COLUMN words_typed INTEGER;
