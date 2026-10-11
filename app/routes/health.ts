// The smallest health route: when the last complete D1 dump finished and how old it is. It sits behind
// Access like every other route (the Worker has no route of its own around the gate), and it carries no
// row, table name or error text.

import { backupHealth } from "@dustinedwards/d1-dump";

import { getEnv } from "~/lib/context";

import type { Route } from "./+types/health";

export async function loader({ context }: Route.LoaderArgs) {
  const { last_ok, age_hours, warning } = await backupHealth(getEnv(context).BACKUPS);
  // A stale, missing or unreadable dump answers 503 so a status monitor sees it; the warning text stays out of the body.
  return Response.json({ backup: { last_ok, age_hours } }, { status: warning ? 503 : 200 });
}
