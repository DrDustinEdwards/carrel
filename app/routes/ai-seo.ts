// A button on the editor: the Claude API writes the page's search description (and search title) and saves the page with
// them set as an AI draft beside the working text. It never changes the working text itself.

import { redirect } from "react-router";
import { engineFor, runAi } from "@dustinedwards/site-runtime/ai-engine";

import { monthSpendMicros, readAiSettings, suggestSeo } from "~/lib/ai-engine.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";

import type { Route } from "./+types/ai-seo";

export async function action({ params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const settings = await readAiSettings(env.DB);
  if (engineFor(settings, "seo") === "subscription")
    throw new Response(
      "Search descriptions are set to the subscription, which has no button: ask a Claude session to write one, or change the AI engine setting.",
      { status: 409 },
    );
  if (!env.ANTHROPIC_API_KEY)
    throw new Response("Carrel has no ANTHROPIC_API_KEY secret yet, so it cannot call the API.", {
      status: 409,
    });
  let draftId = 0;
  const ran = await runAi({
    settings,
    feature: "seo",
    spentMicros: await monthSpendMicros(env.DB),
    api: async () => {
      const made = await suggestSeo(env, project, viewer, params.item);
      if (made.ok) draftId = made.draftId;
      return made;
    },
  });
  if (!ran.ok) throw new Response(ran.error, { status: 502 });
  return redirect(`/p/${params.project}/e/${params.item}/ai/${draftId}`);
}
