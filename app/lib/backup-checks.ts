// What Carrel's nightly dump must leave out and carry, for d1-dump's runCheckedBackup, which runs the
// standard checks (not empty, nothing excluded present, every required table there) and this one.

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

/** Carrel cannot run without its Owner, so a dump with no people row is an emptied or wrong database. */
export function ownerProblems(dump: DumpResult): string[] {
  const people = dump.tables.find((t) => t.name === "people")?.rows ?? 0;
  return people > 0 ? [] : ["the dump holds no people, so not even the Owner"];
}

export const BACKUP_OPTIONS = { exclude: [...EXCLUDED_TABLES], required: [...REQUIRED_TABLES], check: ownerProblems };
