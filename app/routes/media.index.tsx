// Media from the menu: one site at a time, because each site stores its own files. Opens the site in the
// address, or the first the viewer may open; the page itself carries the scope chip to change it.

import { redirect } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";
import { can } from "~/lib/roles";

import type { Route } from "./+types/media.index";

export async function loader({ request, context }: Route.LoaderArgs) {
  const visible = await visibleProjects(getEnv(context).DB, getViewer(context));
  const sites = visible.filter((p) => p.kind === "site" && can(p.role, "read"));
  const wanted = new URL(request.url).searchParams.get("site");
  const pick = sites.find((p) => p.slug === wanted) ?? sites[0];
  if (!pick) throw new Response("Not found", { status: 404 });
  return redirect(`/p/${encodeURIComponent(pick.slug)}/media`);
}
