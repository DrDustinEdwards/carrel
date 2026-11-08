// The writing buttons on a book file: continue it, or suggest edits. The AI switch picks the engine; the result is an AI
// draft beside Dustin's file, never committed to Git.

import { getEnv, getViewer } from "~/lib/context";
import { writeBookFile } from "~/lib/ai-write.server";
import { indexedFile, requireBookProject } from "~/lib/books.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.ai-write";

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "edit");
  const form = await readForm(request);
  const job = String(form.get("job") ?? "");
  const only =
    form.get("engine") === "api" || form.get("engine") === "subscription"
      ? (form.get("engine") as "api" | "subscription")
      : undefined;
  const path = String(form.get("path") ?? "");
  if (job !== "continue" && job !== "edit") throw new Response("Not found", { status: 404 });
  const file = await indexedFile(env.DB, project, path);
  if (!file) throw new Response("Not found", { status: 404 });
  const made = await writeBookFile(env, project, viewer, path, job, file.source, only);
  if (!made.ok) return { error: made.error, engine: made.engine ?? null, job };
  return made.engine === "api"
    ? {
        engine: made.engine,
        job,
        message: "Written through the Claude API and saved beside your file.",
        href: null,
      }
    : {
        engine: made.engine,
        job,
        message:
          "Sent to your subscription's routine. The draft appears beside your file when it finishes.",
        href: made.sessionUrl,
      };
}
