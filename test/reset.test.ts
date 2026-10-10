import { describe, expect, it } from "vitest";

import { addPerson, addProject, resetDb, testEnv } from "./env";

const count = async (table: string) =>
  (await testEnv.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first<{ n: number }>())!.n;

describe("resetDb", () => {
  it("empties every table the migrations created", async () => {
    await addPerson("owner@test.invalid", { owner: true });
    await addProject("site");
    await resetDb();
    const { results } = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'site_items_fts_%' AND name NOT IN ('d1_migrations', 'mcp_calls')",
    ).all<{ name: string }>();
    for (const { name } of results) expect(await count(name), name).toBe(0);
  });

  // The day a migration adds a table, a hand-kept list of tables to clear is one short and the new table's rows leak
  // from one case into the next. A table created here stands in for that migration.
  it("empties a table no list names", async () => {
    await testEnv.DB.prepare("CREATE TABLE IF NOT EXISTS added_by_a_later_migration (x TEXT)").run();
    try {
      await testEnv.DB.prepare("INSERT INTO added_by_a_later_migration VALUES ('leaks')").run();
      await resetDb();
      expect(await count("added_by_a_later_migration")).toBe(0);
    } finally {
      await testEnv.DB.prepare("DROP TABLE added_by_a_later_migration").run();
    }
  });
});
