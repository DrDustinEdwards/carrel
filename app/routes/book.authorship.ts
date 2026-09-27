// The authorship record as a readable report (design decision 11): who changed what, person or AI
// client, with the words each change added and removed. Anyone who can read the book can read it.

import { authorshipRecord, authorshipReport, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";

import type { Route } from "./+types/book.authorship";

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const report = authorshipReport(project, await authorshipRecord(env.DB, project));
  return new Response(report, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${project.book}-authorship.md"`,
      "Cache-Control": "no-store",
    },
  });
}
