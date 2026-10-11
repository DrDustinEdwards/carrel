// The nightly D1 dump into BACKUPS, by d1-dump: dump without the completion marker, check, write the
// marker, then prune. A run that fails a check keeps its objects as evidence but has no marker, so it is
// never the newest dump and the health check's age keeps growing until a good run lands.

import { dumpDatabase, pruneDumps, writeCompleteMarker } from "@dustinedwards/d1-dump";

import { checkDump, EXCLUDED_TABLES } from "~/lib/backup-checks";

export class BackupFailed extends Error {}

export async function runBackup(env: Env, now: Date = new Date()) {
  const dump = await dumpDatabase(env.DB, env.BACKUPS, { exclude: [...EXCLUDED_TABLES], markComplete: false, now });
  const failed = checkDump(dump).filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new BackupFailed(`Dump ${dump.run_id} was not marked complete. ${failed.map((c) => `${c.name}: ${c.detail}`).join(" ")}`);
  }
  await writeCompleteMarker(env.BACKUPS, dump);
  const pruned = await pruneDumps(env.BACKUPS);
  return { dump, pruned };
}
