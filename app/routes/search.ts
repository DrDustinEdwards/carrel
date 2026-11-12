// The header search's results as JSON, for the command menu: posts on every site and every book the
// viewer may open whose title has every word typed. A resource route behind the same gate as the pages.

import { jsonResponse } from "@dustinedwards/site-runtime/http";

import { getEnv, getViewer } from "~/lib/context";
import { searchEverything } from "~/lib/desk.server";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/search";

export async function loader({ request, context }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length === 0 || q.length > 200) return Response.json([]);
  const env = getEnv(context);
  const visible = await visibleProjects(env.DB, getViewer(context));
  return jsonResponse(await searchEverything(env.DB, visible, q));
}
