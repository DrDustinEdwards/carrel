// The posts endpoint for one project, JSON both ways, so the posts list reads an answer and never an
// HTML page. POST with an `intent` runs it through the content kit (lib/posts.server.ts), as the list's
// page does with no script. A Reader may post only Refresh; the kit refuses a write the role does not
// allow before the site hears anything.

import { getEnv, getViewer } from "~/lib/context";
import { runIntent } from "~/lib/posts.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/posts.api";

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  return Response.json(await runIntent(getEnv(context), getViewer(context), params.project, await readForm(request)));
}
