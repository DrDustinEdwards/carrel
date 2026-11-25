-- The AI that made a book through the MCP door (carrel_create_book). An AI writes, links and deletes only a book an
-- AI made; in a book made in Desk it saves drafts beside Dustin's files. Null for every project before this.
ALTER TABLE projects ADD COLUMN made_by TEXT;
