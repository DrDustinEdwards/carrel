// The writing buttons on the editor: the search description, continue the draft, suggest edits. The AI switch picks the
// engine for each; the result is an AI draft beside the working text. It never changes the working text itself.

import {
  engineFrom,
  writeAnswer,
  writePost,
  writeRequest,
  type WriteJob,
} from "~/lib/ai-write.server";
import { requireSiteProject } from "~/lib/projects.server";

import type { Route } from "./+types/ai-write";

const JOBS = ["seo", "continue", "edit"] as const;

export async function action({ request, params, context }: Route.ActionArgs) {
  const { viewer, env, form, job } = await writeRequest(request, context);
  if (!JOBS.includes(job as WriteJob)) throw new Response("Not found", { status: 404 });
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const made = await writePost(
    env,
    project,
    viewer,
    params.item,
    job as WriteJob,
    engineFrom(form),
  );
  return writeAnswer(made, job, "text", `/p/${params.project}/e/${params.item}/ai`);
}
