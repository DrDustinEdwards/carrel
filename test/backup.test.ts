// The nightly D1 dump: it leaves credential tables out, passes d1-dump's credential-column check, requires the
// authorship and AI draft tables, and is marked complete only after its own checks. Each failure is planted here and must be seen red.

import { BackupIncomplete, backupHealth, dumpDatabase, latestDump, standardProblems, type DumpResult } from "@dustinedwards/d1-dump";
import { beforeEach, describe, expect, it } from "vitest";

import { BACKUP_CRON, BACKUP_OPTIONS, EXCLUDED_TABLES, REQUIRED_TABLES } from "~/lib/backup-checks";
import { runBackup } from "~/lib/backup.server";
import { CRON_JOBS } from "~/lib/cron-schedule";
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

  it("the nightly cron in the Worker config is the one the handler runs the dump on, and every trigger has its jobs", () => {
    expect(example).toContain(`"${BACKUP_CRON}"`);
    expect(CRON_JOBS[BACKUP_CRON]?.map((j) => j.name)).toContain("backup");
    const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(example)?.[1] ?? "[]") as string[];
    expect(crons.length).toBeGreaterThan(1);
    expect(Object.keys(CRON_JOBS).sort()).toEqual([...crons].sort());
    expect(example).toMatch(/"binding": "BACKUPS",\s*"bucket_name": "carrel-backups"/);
  });
});
