// The editor's media endpoint for one project (stage 3): GET lists the site's files for the library
// picker, POST uploads one file for the editor's paste, drop or Insert image, and the library's upload
// queue and crop. GET ?bytes=<id> is one image's own bytes, for the crop editor: through Carrel, so the
// browser can export the canvas it draws them on, which an image from the site's origin would taint. JSON both ways, so the
// editor reads an answer and never an HTML page. The roles are the library's: a Reader may list, and
// only an Editor or the Owner uploads.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { getEnv, getViewer } from "~/lib/context";
import { listMedia, mediaBytes, uploadMedia } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/media.api";

function unreachable(error: unknown): string | null {
  if (error instanceof SiteNotConnected) return `The site is not connected: ${error.detail}`;
  if (error instanceof SiteApiError) return error.body ? `The site refused: ${error.body.message}` : `The site answered ${error.status}.`;
  return null;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const url = new URL(request.url);
  const bytesOf = url.searchParams.get("bytes");
  if (bytesOf) {
    try {
      const file = await mediaBytes(env, project, bytesOf);
      if (!file) return Response.json({ error: "The site has no image by that id that Carrel can open." }, { status: 404 });
      return new Response(file.bytes, { headers: { "content-type": file.type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "attachment" } });
    } catch (error) {
      const message = unreachable(error);
      if (message === null) throw error;
      return Response.json({ error: message }, { status: 502 });
    }
  }
  try {
    return Response.json(
      await listMedia(env, project, {
        q: url.searchParams.get("q")?.trim().slice(0, 200) || undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        limit: 60,
      }),
    );
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return Response.json({ items: [], nextCursor: null, error: message });
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  // Refused on the role before the body is read: a Reader's upload never reaches the site.
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No file was chosen." }, { status: 400 });
  try {
    const outcome = await uploadMedia(
      env,
      project,
      { viewer },
      { name: file.name, type: file.type, size: file.size, bytes: () => file.arrayBuffer() },
      String(form.get("alt") ?? ""),
    );
    if (!outcome.ok) return Response.json({ error: outcome.message }, { status: 422 });
    return Response.json({ id: outcome.item.id, url: outcome.item.url, src: outcome.item.src }, { status: 201 });
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return Response.json({ error: message }, { status: 502 });
  }
}
