// The nightly D1 dump: it leaves credential tables out, requires the authorship and AI draft tables,
// and is marked complete only after its own checks. Each failure is planted here and must be seen red.

import { BackupIncomplete, backupHealth, dumpDatabase, latestDump, standardProblems, type DumpResult } from "@dustinedwards/d1-dump";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { BACKUP_CRON, BACKUP_OPTIONS, EXCLUDED_TABLES, REQUIRED_TABLES } from "~/lib/backup-checks";
import { runBackup } from "~/lib/backup.server";
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

const problems = (dump: DumpResult) => [...standardProblems(dump, BACKUP_OPTIONS), ...BACKUP_OPTIONS.check(dump)];

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
    await expect(runBackup(testEnv)).rejects.toThrow(BackupIncomplete);
    expect(await latestDump(testEnv.BACKUPS)).toBeNull();
    expect((await backupHealth(testEnv.BACKUPS)).last_ok).toBeNull();
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { exclude: [...EXCLUDED_TABLES], markComplete: false });
    expect(problems(dump)).toEqual(["the dump holds no people, so not even the Owner"]);
  });

  it("PLANT credential table left in: the check names it", async () => {
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { markComplete: false });
    expect(problems(dump)).toEqual(["google_tokens is in the dump but must be excluded", "google_oauth_states is in the dump but must be excluded"]);
  });

  it("PLANT missing required table: the check names it", async () => {
    const dump = await dumpDatabase(testEnv.DB, testEnv.BACKUPS, { exclude: [...EXCLUDED_TABLES, "authorship"], markComplete: false });
    expect(problems(dump)).toEqual(["authorship is missing from the dump"]);
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
    return { status: response.status, ...((await response.json()) as { db: string; backup: { last_ok: string | null } }) };
  }

  // healthResponse itself is tested in site-runtime; this checks Carrel wires D1 and the dump into it.
  it("says D1 is up and reports the dump", async () => {
    expect(await body()).toMatchObject({ status: 200, db: "up", backup: { last_ok: null } });
  });
});
