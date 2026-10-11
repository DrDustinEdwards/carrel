// The nightly D1 dump: it leaves credential tables out, requires the authorship and AI draft tables,
// and is marked complete only after its own checks. Each failure is planted here and must be seen red.

import { backupHealth, dumpDatabase, latestDump } from "@dustinedwards/d1-dump";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { BACKUP_CRON, checkDump, EXCLUDED_TABLES, REQUIRED_TABLES } from "~/lib/backup-checks";
import { BackupFailed, runBackup } from "~/lib/backup.server";
import { cloudflareContext } from "~/lib/context";
import { loader as healthLoader } from "~/routes/health";
import example from "../wrangler.jsonc.example?raw";

import { addPerson, resetDb, testEnv } from "./env";

async function emptyBucket() {
  const listed = await testEnv.BACKUPS.list();
  await Promise.all(listed.objects.map((o) => testEnv.BACKUPS.delete(o.key)));
}

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
  await addPerson("owner@test.invalid", { owner: true });
});

const failing = (dump: Parameters<typeof checkDump>[0]) => checkDump(dump).filter((c) => !c.ok).map((c) => c.name);

describe("the nightly dump", () => {
  it("writes a complete run without the credential tables, keeps the required ones, and reports its age", async () => {
    await testEnv.DB.prepare("INSERT INTO google_oauth_states (state, person_id) VALUES ('one-time', 1)").run();
    const { dump } = await runBackup(testEnv);
    const names = dump.tables.map((t) => t.name);
    expect(names.length).toBeGreaterThan(10);
    for (const t of EXCLUDED_TABLES) expect(names).not.toContain(t);
    for (const t of REQUIRED_TABLES) expect(names).toContain(t);
    expect(dump.keys.some((k) => k.includes("one-time"))).toBe(false);
    expect((await latestDump(testEnv.BACKUPS))?.run_id).toBe(dump.run_id);
    const health = await backupHealth(testEnv.BACKUPS);
    expect(health.warning).toBeUndefined();
    expect(health.age_hours).toBeLessThan(1);
  });

  it("PLANT empty dump: the run is not marked complete and the bucket has no newest dump", async () => {
    await testEnv.DB.prepare("DELETE FROM people").run();
    await expect(runBackup(testEnv)).rejects.toThrow(BackupFailed);
    expect(await latestDump(testEnv.BACKUPS)).toBeNull();
    expect((await backupHealth(testEnv.BACKUPS)).last_ok).toBeNull();
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { exclude: [...EXCLUDED_TABLES], markComplete: false });
    expect(failing(dump)).toEqual(["not-empty"]);
  });

  it("PLANT credential table left in: the check names it", async () => {
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { markComplete: false });
    expect(failing(dump)).toEqual(["no-credential-tables"]);
    expect(checkDump(dump).find((c) => c.name === "no-credential-tables")?.detail).toContain("google_tokens");
  });

  it("PLANT missing required table: the check names it", async () => {
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { exclude: [...EXCLUDED_TABLES, "authorship"], markComplete: false });
    expect(failing(dump)).toEqual(["required-tables"]);
    expect(checkDump(dump).find((c) => c.name === "required-tables")?.detail).toContain("authorship");
  });

  it("every table that looks like a credential is excluded or reviewed, and every excluded name is a table", async () => {
    const tables = (await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results.map((r) => r.name);
    // Reviewed and kept on purpose: none holds a live credential. google_keys_seen holds a key's public id and first-seen date.
    const reviewed = ["google_keys_seen"];
    const looksSecret = /token|secret|password|credential|refresh|oauth_state|_states$/i;
    const flagged: string[] = [];
    for (const name of tables) {
      const columns = (await testEnv.DB.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>()).results.map((r) => r.name);
      if (looksSecret.test(name) || columns.some((c) => looksSecret.test(c))) flagged.push(name);
    }
    expect(tables.length).toBeGreaterThan(20);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.filter((t) => !(EXCLUDED_TABLES as readonly string[]).includes(t) && !reviewed.includes(t))).toEqual([]);
    expect(EXCLUDED_TABLES.filter((t) => !tables.includes(t))).toEqual([]);
  });

  it("the nightly cron in the Worker config is the one the handler runs the dump on", () => {
    expect(example).toContain(`"${BACKUP_CRON}"`);
    expect(example).toMatch(/"binding": "BACKUPS",\s*"bucket_name": "carrel-backups"/);
  });
});

describe("GET /health", () => {
  async function body() {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: testEnv, ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext });
    const response = await healthLoader({ context, request: new Request("https://carrel.test/health"), params: {} } as never);
    return response.json() as Promise<{ backup: Record<string, unknown> }>;
  }

  it("reports only last_ok and age_hours", async () => {
    await runBackup(testEnv);
    const { backup } = await body();
    expect(Object.keys(backup).sort()).toEqual(["age_hours", "last_ok"]);
    expect(backup.last_ok).toEqual(expect.any(String));
  });

  it("reports nulls when there is no complete dump", async () => {
    expect((await body()).backup).toEqual({ last_ok: null, age_hours: null });
  });
});
