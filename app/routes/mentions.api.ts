// The mentions endpoint for one project, JSON both ways, so the mentions list reads an answer and never
// an HTML page. POST with an `intent` runs it through the content kit (lib/mentions.server.ts), as the
// list's page does with no script. The Owner's alone, refused before the body is read.

import { getEnv, getViewer } from "~/lib/context";
import { runIntent } from "~/lib/mentions.server";
import { requireSiteProject } from "~/lib/projects.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/mentions.api";

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const env = getEnv(context);
  const viewer = getViewer(context);
  try {
    await requireSiteProject(env.DB, viewer, params.project, "decide_mention");
  } catch (thrown) {
    if (thrown instanceof Response && thrown.status === 403) return Response.json({ error: "Deciding mentions is the Owner's step." }, { status: 403 });
    throw thrown;
  }
  return Response.json(await runIntent(env, viewer, params.project, await readForm(request)));
}
