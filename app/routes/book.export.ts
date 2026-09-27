// Export: ePub and Word built here, and the print page the browser turns into a PDF. The Owner's
// step, like publish, and held while any flag is open. Git is read first where it can be, so the
// export is what Git holds, and the checks have seen it.

import { assembleBook, bookRepo, exportGate, refreshBook, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { buildDocx, buildEpub, printHtml, slugFor } from "~/lib/novels/export";

import type { Route } from "./+types/book.export";

const FORMATS = ["epub", "docx", "print"] as const;

function held(message: string, slug: string): Response {
  return new Response(`${message}\n\nOpen /b/${slug} to see the flags.\n`, {
    status: 409,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const format = params.format as (typeof FORMATS)[number];
  if (!FORMATS.includes(format)) throw new Response("Not found", { status: 404 });
  const project = await requireBookProject(env.DB, viewer, params.project, "publish");

  const { repo } = bookRepo(env);
  if (repo) {
    try {
      await refreshBook(env.DB, repo, project);
    } catch (error) {
      return new Response(`Git could not be read, so there is nothing current to export: ${error instanceof Error ? error.message : String(error)}\n`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }
  const gate = await exportGate(env.DB, project);
  if (!gate.ok) return held(gate.message, project.slug);

  const book = await assembleBook(env.DB, project, viewer);
  const name = slugFor(book.title);
  const download = (body: BodyInit, type: string, ext: string) =>
    new Response(body, {
      headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}.${ext}"`, "Cache-Control": "no-store" },
    });

  switch (format) {
    case "epub":
      return download(buildEpub(book, { id: crypto.randomUUID(), modified: new Date() }), "application/epub+zip", "epub");
    case "docx":
      return download(await buildDocx(book), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
    case "print":
      return new Response(printHtml(book), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          // Its own policy: the page is the book and one inline style, and nothing runs.
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
  }
}
