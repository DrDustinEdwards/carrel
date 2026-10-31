// What Carrel's nightly dump must leave out and carry, for d1-dump's runCheckedBackup, which runs the
// standard checks (not empty, nothing excluded present, every required table there), its credential-column check
// and this one.
//
// What the dump covers is D1 alone. The rest of Carrel's storage, and why it is not backed up (B7):
// - OAUTH_KV: the AI door's OAuth grants, tokens and client registrations. Live credentials, which a backup bucket must
//   never carry; lost, each AI client signs in again, and nothing written is lost.
// - DOC_ROOM (Durable Objects): each open file's shared working copy. Every room mirrors its text into D1's `rooms`
//   after each change, and its comments are written to D1's `comments` (docs/coediting.md); the dump carries both.
// - MCP_RATE_LIMIT (Durable Objects): per-person request counters that reset every minute. Nothing to keep.
// - TOOL_CALL_LOG (Durable Objects): the AI door's append-only call log, an audit trail rather than writing. Every change
//   an AI call made is in D1's `authorship` and `ai_drafts`, which the dump requires; losing the log loses the trail
//   only, and reading it out would need an export the door does not have.
// - BACKUPS (R2) is where the dumps go. Carrel stores no files of its own: media lives on each site, and manuscripts in
//   Google Drive and the private writing repository.

import type { DumpResult } from "@dustinedwards/d1-dump";

/** The cron expression that runs the nightly dump; the other cron in wrangler.jsonc.example runs the rest. */
export const BACKUP_CRON = "17 3 * * *";

/**
 * Tables that hold a live credential or a one-time token, which a backup bucket must never carry.
 * google_tokens: Dustin's drive.file refresh token (encrypted, but still a live credential).
 * google_oauth_states: the one-time `state` values of an OAuth sign-in in flight.
 * Any other column whose name says credential fails the night (d1-dump's `credentials`) until it is excluded here or
 * allowed below with its reason.
 */
export const EXCLUDED_TABLES = ["google_tokens", "google_oauth_states"] as const;

/** Tables that exist nowhere else: the authorship record and the AI drafts saved beside Dustin's. */
export const REQUIRED_TABLES = ["authorship", "ai_drafts"] as const;

/** Carrel cannot run without its Owner, so a dump with no people row is an emptied or wrong database. */
function ownerProblems(dump: DumpResult): string[] {
  const people = dump.tables.find((t) => t.name === "people")?.rows ?? 0;
  return people > 0 ? [] : ["the dump holds no people, so not even the Owner"];
}

/** Columns d1-dump's credential check would flag that hold no credential. */
const CREDENTIAL_ALLOW = {
  "google_keys_seen.private_key_id": "the service account key's public id and first-seen date, never the key",
};

export const BACKUP_OPTIONS = {
  exclude: [...EXCLUDED_TABLES],
  required: [...REQUIRED_TABLES],
  check: ownerProblems,
  credentials: { allow: CREDENTIAL_ALLOW },
};
