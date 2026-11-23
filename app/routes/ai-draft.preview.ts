// The AI draft page's rendered view: one AI draft of the viewer's, rendered by the site's own
// pipeline and served under the same sandboxing policy as the editor's preview. Read-only; nothing
// here writes to the site or to anyone's draft.

import { draftIdParam } from "~/components/editor/draft-head";
import { readAiDraft } from "~/lib/ai.server";
import { getEnv, getViewer } from "~/lib/context";
import { failed, previewFailure, previewResponse } from "~/lib/preview.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteClient, siteConnection } from "~/lib/sites.server";

import type { Route } from "./+types/ai-draft.preview";

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const draft = await readAiDraft(env.DB, project, viewer, params.item, draftIdParam(params.id));
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected")
    return previewFailure(`The site is not connected: ${connection.detail}`);

  try {
    const html = await siteClient(env, project.site).preview({
      id: params.item,
      source: draft.source,
    });
    return previewResponse(html, connection.origin);
  } catch (error) {
    return failed(error, { itemId: params.item, aiDraft: draft.id });
  }
}
