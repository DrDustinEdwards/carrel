// The media endpoint for one project, JSON both ways, so a screen reads an answer and never an HTML
// page. GET ?bytes=<id> is one image's own bytes, for the crop editor: through Carrel, so the browser
// can export the canvas it draws them on, which an image from the site's origin would taint. GET with
// the library's query is one page of the library's data (the editor's image picker); with only `q`, the
// matching files for quick search. GET ?changes=<cursor> is what others changed on the site since that
// cursor (site-api v0.13.0's loadMediaChanges), for the library's live updates: the files as they are
// now and the ids deleted for good, or `{ reload: true }` when the site can no longer answer from it.
// POST with an `intent` runs it through the content kit, as the
// library's page does with no script; POST with only a file is the editor's paste, drop or Insert
// image, answered with the site's address for it. A Reader may read; the kit refuses a write the role
// does not allow before the site hears anything.

import { loadMedia, loadMediaChanges, readMediaQuery, runMediaIntent } from "@dustinedwards/site-api/admin";
import { mediaDataOfKit, readMediaView } from "capsomer/behavior/media-library";

import { getEnv, getViewer } from "~/lib/context";
import { mediaBytes, mediaSource, runIntent, unreachable, useHref } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { absoluteMediaUrl } from "~/lib/sites.server";

import type { Route } from "./+types/media.api";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const search = new URL(request.url).searchParams;
  try {
    const source = mediaSource(env, project, viewer);
    const bytesOf = search.get("bytes");
    if (bytesOf) {
      const file = await mediaBytes(source, bytesOf);
      if (!file) return Response.json({ error: "The site has no image by that id that Carrel can open." }, { status: 404 });
      return new Response(file.bytes, { headers: { "content-type": file.type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "attachment" } });
    }
    const since = search.get("changes");
    if (since !== null) return Response.json(await loadMediaChanges(source, since.slice(0, 500)), { headers: { "cache-control": "private, no-store" } });
    const kit = await loadMedia(source, readMediaQuery(search));
    const pick = search.get("pick") ?? "";
    return Response.json(mediaDataOfKit(kit, { usedHref: (use) => useHref(project.slug, use), view: { ...readMediaView(search), ...(pick ? { pick } : {}) } }));
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return Response.json({ error: message }, { status: 502 });
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  if (form.get("intent")) return Response.json(await runIntent(env, viewer, params.project, form));
  // The editor's upload: refused on the role before the site is asked anything.
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  form.set("intent", "upload");
  try {
    const source = mediaSource(env, project, viewer);
    const uploaded = await runMediaIntent(source, form);
    const id = uploaded.ok ? uploaded.outcomes?.[0]?.id : undefined;
    if (!id) return Response.json({ error: uploaded.message }, { status: 422 });
    const item = await source.client.media.get(id);
    return Response.json({ id, url: item.url, src: absoluteMediaUrl(source.site.origin, item.url) }, { status: 201 });
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return Response.json({ error: message }, { status: 502 });
  }
}
