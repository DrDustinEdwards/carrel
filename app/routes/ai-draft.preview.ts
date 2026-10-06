// The AI draft page's rendered view: one AI draft of the viewer's, rendered by the site's own
// pipeline and served under the same sandboxing policy as the editor's preview. Read-only; nothing
// here writes to the site or to anyone's draft.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { readAiDraft } from "~/lib/ai.server";
import { getEnv, getViewer } from "~/lib/context";
import { previewFailure, previewResponse } from "~/lib/preview.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteClient, siteConnection, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/ai-draft.preview";

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new Response("Not found", { status: 404 });
  const draft = await readAiDraft(env.DB, project, viewer, params.item, id);
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected") return previewFailure(`The site is not connected: ${connection.detail}`);

  try {
    const html = await siteClient(env, project.site).preview({ id: params.item, source: draft.source });
    return previewResponse(html, connection.origin);
  } catch (error) {
    if (error instanceof SiteNotConnected) return previewFailure(error.detail);
    if (error instanceof SiteApiError && error.body) return previewFailure(`The site could not render this: ${error.body.message}`);
    console.error(JSON.stringify({ preview: "failed", itemId: params.item, aiDraft: id, error: String(error) }));
    return previewFailure("The site did not answer the preview request.");
  }
}
