// The posts list's bulk endpoint: one action on several posts, answered as JSON with an outcome for
// every post. Roles are checked in bulk.server.ts (a delete is the Owner's, a tag or a copy is an
// Editor's, and a live post's change is refused for an Editor on that post alone), before the site
// is asked anything. POST only.

import { bulkApply, type BulkRequest } from "~/lib/bulk.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";

import type { Route } from "./+types/project.bulk";

function parse(form: FormData): BulkRequest | null {
  const op = String(form.get("op") ?? "");
  switch (op) {
    case "tag-add":
    case "tag-remove":
      return { op, tag: String(form.get("tag") ?? "") };
    case "duplicate":
    case "delete":
      return { op };
    default:
      return null;
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const form = await request.formData();
  const bulk = parse(form);
  if (!bulk) return Response.json({ error: "That is not a bulk action." }, { status: 400 });
  try {
    const results = await bulkApply(env, project, viewer, bulk, form.getAll("id").map(String));
    return Response.json({ results });
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    if (thrown.status === 403) {
      return Response.json({ error: bulk.op === "delete" ? "Deleting posts is the Owner's step." : "You may not change posts here." }, { status: 403 });
    }
    return Response.json({ error: (await thrown.text()) || "The request was not accepted." }, { status: thrown.status });
  }
}
