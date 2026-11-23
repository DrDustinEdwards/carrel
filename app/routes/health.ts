// The browser host's /health, behind Access like every other route. The AI door answers the same (health.server.ts).

import { getEnv } from "~/lib/context";
import { deskHealthAnswer } from "~/lib/health.server";

import type { Route } from "./+types/health";

export function loader({ context }: Route.LoaderArgs) {
  return deskHealthAnswer(getEnv(context));
}
