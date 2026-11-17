// The webmention queue for a site: Capsomer's MentionsList over the content kit (lib/mentions.server.ts),
// the same screen and the same intents as each site's own admin. Tabs by state with the site's counts,
// each row's decisions, the bulk bar with an outcome per mention, Undo where the site can reverse a
// decision, paging, and delete and the retention sweep behind a confirm. Everything a stranger sent is
// drawn as text: the source address is never a link. Every action is a form post, so it all works with
// no script; with script the posts go through the mentions endpoint and answer in place.

import { loadMentions, readMentionsQuery, type IntentResult } from "@dustinedwards/site-api/admin";
import { kitMentionsSearch, mentionsDataOfKit } from "capsomer/behavior/mentions-list";
import { Banner } from "capsomer/react/banner";
import { MentionsList } from "capsomer/react/mentions-list";
import { PageHead } from "capsomer/react/page-head";

import { KitForm, useKitSubmit } from "capsomer/react/kit-form";
import { getEnv, getViewer } from "~/lib/context";
import { mentionsSource, runIntent, unreachable } from "~/lib/mentions.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/mentions";
import { logEvent } from "@dustinedwards/site-runtime/log";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Mentions · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  // The Owner's alone, as Dustin ruled for the inbox (2026-09-26): anyone else is refused before the site is asked.
  const project = await requireSiteProject(env.DB, viewer, params.project, "read_mentions");
  const head = { slug: project.slug, name: project.name, site: siteEntry(project.site).name };
  const search = new URL(request.url).searchParams;
  try {
    const kit = await loadMentions(
      mentionsSource(env, project, viewer),
      readMentionsQuery(kitMentionsSearch(search)),
    );
    if (!kit.offers.mentions)
      return {
        project: head,
        data: null,
        unavailable: "This site does not receive webmentions through Carrel yet.",
      };
    return { project: head, data: mentionsDataOfKit(kit, search), unavailable: null };
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    logEvent("mentions.list-failed", { error: String(error) }, { level: "error" });
    return { project: head, data: null, unavailable: message };
  }
}

export async function action({
  params,
  request,
  context,
}: Route.ActionArgs): Promise<IntentResult> {
  return runIntent(getEnv(context), getViewer(context), params.project, await readForm(request));
}

export default function Mentions({ loaderData, actionData }: Route.ComponentProps) {
  const { project, data, unavailable } = loaderData;
  const base = `/p/${encodeURIComponent(project.slug)}/mentions`;
  const submit = useKitSubmit(`${base}/api`);
  return (
    <div className="cap-admin-page">
      <PageHead
        title={project.name}
        lead={`Webmentions about posts on ${project.site}. Approving one shows it on the post within seconds.`}
      />
      {unavailable || !data ? (
        <Banner tone="warn" title="Mentions are not available for this site yet">
          {unavailable}
        </Banner>
      ) : (
        <MentionsList
          data={data}
          action={base}
          Form={KitForm}
          submit={submit}
          result={actionData ?? null}
        />
      )}
    </div>
  );
}
