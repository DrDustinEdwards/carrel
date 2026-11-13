// Which jobs each cron trigger runs, how often, and how long each may take (site-runtime's ./cron). workers/app.ts gives
// each name its work; /health's cron check (health.server.ts) reads this same list, so a job that never ran, such as one
// under a misspelt trigger, warns. Every trigger in wrangler.jsonc.example has a list here (test/backup.test.ts), and a
// trigger with none is logged and fails the invocation rather than running nothing in silence.

import { BACKUP_CRON } from "~/lib/backup-checks";

const QUARTER_HOUR_CRON = "*/15 * * * *";

export type JobName =
  | "health"
  | "refresh-sites"
  | "refresh-google"
  | "inbox-report"
  | "social"
  | "episode-drafts"
  | "backup"
  | "prune-404"
  | "signed-in-crawl"
  | "tool-call-log-export"
  | "docs-email";

// `backup` marks the jobs Capsid Admin's back up now runs (site-runtime runJobTool's `{ backup: true }`).
export type ScheduledJob = {
  name: JobName;
  everyMinutes: number;
  timeoutMs: number;
  backup?: boolean;
};

const MINUTE = 60_000;

/**
 * The quarter-hour jobs' timeouts add up to 14 minutes 45 seconds, under the trigger's own 15, so a hung job is recorded failed and
 * the rest still run before the next trigger. The nightly dump gets 10 minutes; pruning the 404 counts is one DELETE.
 */
export const CRON_JOBS: Record<string, ScheduledJob[]> = {
  [QUARTER_HOUR_CRON]: [
    { name: "health", everyMinutes: 15, timeoutMs: 4 * MINUTE },
    { name: "refresh-sites", everyMinutes: 15, timeoutMs: 4 * MINUTE },
    { name: "refresh-google", everyMinutes: 15, timeoutMs: 2 * MINUTE },
    { name: "inbox-report", everyMinutes: 15, timeoutMs: 1 * MINUTE },
    { name: "social", everyMinutes: 15, timeoutMs: 3 * MINUTE },
    // Germomics episodes (published or not) with a transcript and no summary or chapters: drafted once each (episode-drafts.server.ts).
    { name: "episode-drafts", everyMinutes: 15, timeoutMs: 1 * MINUTE },
    // Desk's signed-in pages graded in-process for devkit's scoreboard (signed-in-crawl.server.ts): a handful of GETs.
    { name: "signed-in-crawl", everyMinutes: 15, timeoutMs: 45_000 },
  ],
  [BACKUP_CRON]: [
    { name: "backup", backup: true, everyMinutes: 1440, timeoutMs: 10 * MINUTE },
    // Carrel's own 404 counts (workers/app.ts) are kept 90 days, site-runtime's default (N7).
    { name: "prune-404", everyMinutes: 1440, timeoutMs: 1 * MINUTE },
    // The AI door's tool-call log copied to R2 and its copied rows past 90 days pruned (site-runtime's exportAuditLog, L6-L7).
    { name: "tool-call-log-export", everyMinutes: 1440, timeoutMs: 2 * MINUTE },
    // The daily summary of AIs' direct writes in Google Docs, when that is Dustin's Docs email setting (docs.server.ts).
    { name: "docs-email", everyMinutes: 1440, timeoutMs: 1 * MINUTE },
  ],
};

/** Every job on every trigger, for the cron check. */
export const ALL_JOBS: ScheduledJob[] = Object.values(CRON_JOBS).flat();
