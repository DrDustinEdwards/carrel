// The browser host's /health, behind Access like every other route. The AI door answers the same (health.server.ts).

import { getEnv } from "~/lib/context";
import { healthAnswer } from "~/lib/health.server";

import type { Route } from "./+types/health";

export function loader({ context }: Route.LoaderArgs) {
  return healthAnswer(getEnv(context));
}
