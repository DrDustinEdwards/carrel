// The writing buttons on a book file: continue it, or suggest edits. The AI switch picks the engine; the result is an AI
// draft beside Dustin's file, never committed to Git.

import { engineFrom, writeAnswer, writeBookFile, writeRequest } from "~/lib/ai-write.server";
import { indexedFile, requireBookProject } from "~/lib/books.server";

import type { Route } from "./+types/book.ai-write";

export async function action({ request, params, context }: Route.ActionArgs) {
  const { viewer, env, form, job } = await writeRequest(request, context);
  const path = String(form.get("path") ?? "");
  if (job !== "continue" && job !== "edit") throw new Response("Not found", { status: 404 });
  const project = await requireBookProject(env.DB, viewer, params.project, "edit");
  const file = await indexedFile(env.DB, project, path);
  if (!file) throw new Response("Not found", { status: 404 });
  const made = await writeBookFile(env, project, viewer, path, job, file.source, engineFrom(form));
  return writeAnswer(made, job, "file");
}
