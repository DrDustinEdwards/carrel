// The preview document for the editor's iframe: the viewer's working copy (or the site's version when
// there is none), rendered by the site's own pipeline, served under a sandboxing policy of its own.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { listAiDrafts, readAiDraft } from "~/lib/ai.server";
import { readDoc, readDraft } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { previewFailure, previewResponse, withLabel } from "~/lib/preview.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteClient, siteConnection, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/preview";

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const itemId = params.item;
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected") return previewFailure(`The site is not connected: ${connection.detail}`);

  try {
    const draft = await readDraft(env.DB, project, viewer, itemId);
    let source = draft?.source ?? (await readDoc(env, project, itemId))?.source;
    let label: string | null = null;
    if (source === undefined) {
      // Nothing of the person's own and nothing on the site: show the newest AI draft, labelled as theirs to take or leave.
      const [latest] = await listAiDrafts(env.DB, project, viewer, itemId);
      if (!latest) return previewFailure("There is nothing to preview yet.");
      source = (await readAiDraft(env.DB, project, viewer, itemId, latest.id)).source;
      label = `AI draft from ${latest.client}. It is not your draft and it is not on the site.`;
    }
    const html = await siteClient(env, project.site).preview({ id: itemId, source });
    return previewResponse(label ? withLabel(html, label) : html, connection.origin);
  } catch (error) {
    if (error instanceof SiteNotConnected) return previewFailure(error.detail);
    if (error instanceof SiteApiError && error.body) return previewFailure(`The site could not render this: ${error.body.message}`);
    console.error(JSON.stringify({ preview: "failed", itemId, error: String(error) }));
    return previewFailure("The site did not answer the preview request.");
  }
}
