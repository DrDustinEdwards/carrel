// The nightly D1 dump into BACKUPS, by d1-dump's createSiteBackup: dump without the completion marker,
// check, write the marker, then prune. A run that fails a check throws BackupIncomplete and keeps its
// objects as evidence without a marker, so the health check's age keeps growing until a good run lands.

import { createSiteBackup } from "@dustinedwards/d1-dump";

import { BACKUP_OPTIONS } from "~/lib/backup-checks";

const backup = createSiteBackup<Env>({ dump: BACKUP_OPTIONS });

export const runBackup = (env: Env, now: Date = new Date()) => backup.runBackup(env, now);

/** The newest complete dump's age and warning, for /health and the operator API. Never throws. */
export const backupStatus = (env: Env, now?: Date) => backup.status(env, now);
