// The browser host's /health, behind Access like every other route: site-runtime's healthResponse, the
// same answer every family site gives. It says whether D1 answers, the last complete D1 dump and the
// deployed commit, as the AI door's /health also does.

import { backupHealth } from "@dustinedwards/d1-dump";
import { healthResponse } from "@dustinedwards/site-runtime/health";

import { getEnv } from "~/lib/context";
import { deployedSha } from "~/lib/deployed";

import type { Route } from "./+types/health";

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  return healthResponse({ ping: () => env.DB.prepare("SELECT 1").first(), backup: () => backupHealth(env.BACKUPS), sha: deployedSha(env) });
}
