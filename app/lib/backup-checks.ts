// The checks a nightly dump must pass before it is marked complete. Pure functions over what the dump
// reports, so a test can plant each failure. A check flags; the caller decides what a failed run does
// (backup.server.ts leaves the run without its marker and throws).

import type { DumpResult } from "@dustinedwards/d1-dump";

/** The cron expression that runs the nightly dump; the other cron in wrangler.jsonc.example runs the rest. */
export const BACKUP_CRON = "17 3 * * *";

/**
 * Tables that hold a live credential or a one-time token, which a backup bucket must never carry.
 * google_tokens: Dustin's drive.file refresh token (encrypted, but still a live credential).
 * google_oauth_states: the one-time `state` values of an OAuth sign-in in flight.
 * test/backup.test.ts derives the credential-shaped tables from drizzle/ and fails if one is neither
 * excluded here nor on the reviewed list in that test.
 */
export const EXCLUDED_TABLES = ["google_tokens", "google_oauth_states"] as const;

/** Tables that exist nowhere else: the authorship record and the AI drafts saved beside Dustin's. */
export const REQUIRED_TABLES = ["authorship", "ai_drafts"] as const;

export type BackupCheck = { name: string; ok: boolean; detail: string };

/** Each check states what it read, so "ok" cannot mean "read nothing". */
export function checkDump(dump: DumpResult): BackupCheck[] {
  const names = dump.tables.map((t) => t.name);
  const totalRows = dump.tables.reduce((sum, t) => sum + t.rows, 0);
  // Carrel cannot run without its Owner, so a dump with no people row is an emptied or wrong database.
  const people = dump.tables.find((t) => t.name === "people")?.rows ?? 0;
  const leaked = EXCLUDED_TABLES.filter((t) => names.includes(t));
  const missing = REQUIRED_TABLES.filter((t) => !names.includes(t));
  return [
    {
      name: "not-empty",
      ok: dump.tables.length > 0 && totalRows > 0 && people > 0,
      detail: `${dump.tables.length} tables and ${totalRows} rows were dumped, ${people} of them people.`,
    },
    {
      name: "no-credential-tables",
      ok: leaked.length === 0,
      detail: leaked.length === 0 ? `None of ${EXCLUDED_TABLES.join(", ")} is in the dump.` : `Credential tables in the dump: ${leaked.join(", ")}.`,
    },
    {
      name: "required-tables",
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${REQUIRED_TABLES.join(" and ")} are in the dump.` : `Missing from the dump: ${missing.join(", ")}.`,
    },
  ];
}
