// The writing buttons on the editor: the search description, continue the draft, suggest edits. The AI switch picks the
// engine for each; the result is an AI draft beside the working text. It never changes the working text itself.

import { getEnv, getViewer } from "~/lib/context";
import { writePost, type WriteJob } from "~/lib/ai-write.server";
import { readForm } from "~/lib/form.server";
import { requireSiteProject } from "~/lib/projects.server";

import type { Route } from "./+types/ai-write";

const JOBS = ["seo", "continue", "edit"] as const;

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const form = await readForm(request);
  const job = String(form.get("job") ?? "");
  const only =
    form.get("engine") === "api" || form.get("engine") === "subscription"
      ? (form.get("engine") as "api" | "subscription")
      : undefined;
  if (!JOBS.includes(job as WriteJob)) throw new Response("Not found", { status: 404 });
  const made = await writePost(env, project, viewer, params.item, job as WriteJob, only);
  if (!made.ok) return { error: made.error, engine: made.engine ?? null, job };
  return made.engine === "api"
    ? {
        engine: made.engine,
        job,
        message: "Written through the Claude API and saved beside your text.",
        href: `/p/${params.project}/e/${params.item}/ai/${made.draftId}`,
      }
    : {
        engine: made.engine,
        job,
        message:
          "Sent to your subscription's routine. The draft appears beside your text when it finishes.",
        href: made.sessionUrl,
      };
}
