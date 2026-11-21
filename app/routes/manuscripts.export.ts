// A Doc in the manuscripts index, downloaded as Markdown, Word, PDF or plain text: the link
// carrel_export_doc gives an AI to hand Dustin, and the Owner's alone, like every Docs tool.

import { attachmentResponse } from "@dustinedwards/site-runtime/r2-object";
import { slugify } from "@drdustinedwards/site-helpers/slug";

import { AiRefusal } from "~/lib/ai.server";
import { getEnv, getViewer } from "~/lib/context";
import { EXPORT_FORMATS, exportGoogleDoc, type ExportFormat } from "~/lib/google/docs.server";

import type { Route } from "./+types/manuscripts.export";

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const format = params.format as ExportFormat;
  if (!EXPORT_FORMATS.includes(format)) throw new Response("Not found", { status: 404 });
  try {
    const file = await exportGoogleDoc(getEnv(context), viewer, params.doc, format);
    return attachmentResponse(file.body, {
      filename: `${slugify(file.name) || "doc"}.${format}`,
      type: file.type,
    });
  } catch (error) {
    if (error instanceof AiRefusal) throw new Response(error.message, { status: 404 });
    throw error;
  }
}
