// The smallest health route: when the last complete D1 dump finished and how old it is. It sits behind
// Access like every other route (the Worker has no route of its own around the gate), and it carries no
// row, table name or error text. It also names the deployed commit, as the AI door's /health does.

import { backupHealth } from "@dustinedwards/d1-dump";

import { getEnv } from "~/lib/context";
import { deployedSha } from "~/lib/deployed";

import type { Route } from "./+types/health";

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const { last_ok, age_hours, warning } = await backupHealth(env.BACKUPS);
  // A stale, missing or unreadable dump answers 503 so a status monitor sees it; the warning text stays out of the body.
  return Response.json({ sha: deployedSha(env), backup: { last_ok, age_hours } }, { status: warning ? 503 : 200 });
}
