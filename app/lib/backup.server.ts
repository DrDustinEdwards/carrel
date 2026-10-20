// The nightly D1 dump into BACKUPS, by d1-dump's runCheckedBackup: dump without the completion marker,
// check, write the marker, then prune. A run that fails a check throws BackupIncomplete and keeps its
// objects as evidence without a marker, so the health check's age keeps growing until a good run lands.

import { runCheckedBackup } from "@dustinedwards/d1-dump";

import { BACKUP_OPTIONS } from "~/lib/backup-checks";

export function runBackup(env: Env, now: Date = new Date()) {
  return runCheckedBackup(env.DB, env.BACKUPS, { ...BACKUP_OPTIONS, now });
}
