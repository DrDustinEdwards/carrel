// The preview document for the editor's iframe: the viewer's working copy (or the site's version when
// there is none), rendered by the site's own pipeline, served under a sandboxing policy of its own.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { readDoc, readDraft } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { previewFailure, previewResponse } from "~/lib/preview.server";
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
    const source = draft?.source ?? (await readDoc(env, project, itemId))?.source;
    if (source === undefined) return previewFailure("There is nothing to preview yet.");
    const html = await siteClient(env, project.site).preview({ id: itemId, source });
    return previewResponse(html, connection.origin);
  } catch (error) {
    if (error instanceof SiteNotConnected) return previewFailure(error.detail);
    if (error instanceof SiteApiError && error.body) return previewFailure(`The site could not render this: ${error.body.message}`);
    console.error(JSON.stringify({ preview: "failed", itemId, error: String(error) }));
    return previewFailure("The site did not answer the preview request.");
  }
}
