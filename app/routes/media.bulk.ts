// The media library's bulk endpoint: one action on several files, answered as JSON with an outcome for
// every file. Roles are checked in media.server.ts before the site is asked anything (delete is the
// Owner's; trash, restore and tags are an Editor's). The site answers file by file, so a stale file or
// one a post uses is refused alone. POST only.
//
// Form fields: `op` (trash, restore, delete, add-tags, remove-tags), `item` once per file as the file's
// id, a tab, and the version the person saw (empty for delete), and `tags` for the tag ops.

import { getEnv, getViewer } from "~/lib/context";
import { bulkMedia, parseMediaTags, type BulkOp } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { SiteNotConnected } from "~/lib/sites.server";
import { SiteApiError } from "@dustinedwards/site-api/client";

import type { Route } from "./+types/media.bulk";

const OPS: readonly BulkOp[] = ["trash", "restore", "delete", "add-tags", "remove-tags"];

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const form = await request.formData();
  const op = OPS.find((o) => o === form.get("op"));
  if (!op) return Response.json({ error: "That is not a bulk action." }, { status: 400 });
  const items = form.getAll("item").map((raw) => {
    const [id = "", version = ""] = String(raw).split("\t");
    return { id, version: version || null };
  });
  let tags: string[] = [];
  if (op === "add-tags" || op === "remove-tags") {
    const parsed = parseMediaTags(String(form.get("tags") ?? ""));
    if (!parsed.ok) return Response.json({ error: parsed.message }, { status: 400 });
    tags = parsed.tags;
  }
  try {
    return Response.json({ results: await bulkMedia(env, project, { viewer }, op, items, tags) });
  } catch (thrown) {
    if (thrown instanceof Response) {
      if (thrown.status === 403) return Response.json({ error: op === "delete" ? "Deleting files is the Owner's step." : "You may not change files here." }, { status: 403 });
      return Response.json({ error: (await thrown.text()) || "The request was not accepted." }, { status: thrown.status });
    }
    if (thrown instanceof SiteNotConnected) return Response.json({ error: `This site is not connected yet: ${thrown.detail}` }, { status: 502 });
    if (thrown instanceof SiteApiError) {
      return Response.json({ error: thrown.body ? `The site refused: ${thrown.body.message}` : `The site answered ${thrown.status}.` }, { status: 502 });
    }
    throw thrown;
  }
}
