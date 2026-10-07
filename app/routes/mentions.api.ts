// The Mentions screen's write endpoint: approve, reject or delete the chosen mentions, or sweep the
// expired ones, answered as JSON with an outcome for every mention. Roles are checked in
// mentions.server.ts (the Owner's alone, before the site is asked anything). POST only.

import { getEnv, getViewer } from "~/lib/context";
import { decideMentions, sweepMentions, type MentionOp } from "~/lib/mentions.server";
import { requireSiteProject } from "~/lib/projects.server";

import type { Route } from "./+types/mentions.api";

const OPS = ["approve", "reject", "delete"] as const;

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const env = getEnv(context);
  const viewer = getViewer(context);
  try {
    // Refused on the role before the body is read: a request from anyone but the Owner never reaches the site.
    const project = await requireSiteProject(env.DB, viewer, params.project, "decide_mention");
    const form = await request.formData();
    const op = String(form.get("op") ?? "");
    if (op === "sweep") return Response.json({ sweep: await sweepMentions(env, project, { viewer }) });
    if (!(OPS as readonly string[]).includes(op)) return Response.json({ error: "That is not a mention action." }, { status: 400 });
    let items: unknown;
    try {
      items = JSON.parse(String(form.get("items") ?? "[]"));
    } catch {
      return Response.json({ error: "The chosen mentions were not readable." }, { status: 400 });
    }
    return Response.json({ results: await decideMentions(env, project, { viewer }, op as MentionOp, items) });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    if (thrown.status === 403) return Response.json({ error: "Deciding mentions is the Owner's step." }, { status: 403 });
    return Response.json({ error: (await thrown.text()) || "The request was not accepted." }, { status: thrown.status });
  }
}
