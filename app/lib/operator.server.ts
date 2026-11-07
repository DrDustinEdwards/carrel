// The operator API Capsid Admin calls (site-runtime ./operator), as on every site. Two tools: backup_status, the backup
// state read now (the same read as /health's backup field), and run_job, every cron job with the work workers/app.ts
// gives it, so a hand run goes through the path its trigger runs, under the job's own timeout, and lands in cron_runs
// where /health's cron check sees it. `{ backup: true }` runs the jobs marked backup.

import { runJobTool, type CronJob } from "@dustinedwards/site-runtime/cron";
import { operatorResponse } from "@dustinedwards/site-runtime/operator";
import { backupStatus } from "~/lib/backup.server";

/** On the AI door's host only: Desk's host is behind Access, which a bearer cannot pass. */
export const OPERATOR_PATH = "/api/operator";

/** The OPERATOR_TOKEN bearer and the AI door's limiter, 30 calls a minute; closed (503) until the secret is set. */
export function operatorAnswer(
  request: Request,
  env: Env,
  jobs: () => CronJob[],
): Promise<Response> {
  return operatorResponse(request, {
    token: env.OPERATOR_TOKEN,
    limiter: env.MCP_RATE_LIMIT,
    tools: {
      backup_status: {
        description:
          "Reads the backup state now, uncached: the newest complete D1 dump's age and each files pass with when it last " +
          "completed, and a warning when any is past 26 hours. The same read as /health's backup field.",
        run: () => backupStatus(env),
      },
      run_job: runJobTool(env.DB, jobs),
    },
  });
}
