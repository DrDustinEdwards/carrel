// The one view for a site: Capsomer's PostsList over the content kit (lib/posts.server.ts), the same
// screen and the same intents as each site's own admin. Status tabs with counts and the Trash, search
// and the filters the site applies, each row's menu, the bulk bar with an outcome per post, Undo, rename
// and preview links, each shown only where the site offers it and the person's role allows. Every
// action is a form post, so it all works with no script; with script the posts go through the posts
// endpoint and answer in place.
//
// Carrel adds the work waiting on the person that the site does not have yet (an AI draft or a draft
// of their own for a new post), the Refresh of its index (which the editor's links and the AI tools
// search), the Share panel and the project tabs.

import { loadPosts, readPostQuery, type IntentResult } from "@dustinedwards/site-api/admin";
import { Banner } from "capsomer/react/banner";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { PostsList, type PostsData } from "capsomer/react/posts-list";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";

import { KitForm, useKitSubmit } from "~/components/kit-form";
import { ProjectTabs } from "~/components/project-tabs";
import { SharePanel } from "~/components/share-panel";

import { getEnv, getViewer } from "~/lib/context";
import { kindsIn, searchItems } from "~/lib/index.server";
import { shareFromForm } from "~/lib/people-admin.server";
import { postsSource, runIntent } from "~/lib/posts.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry, siteUnreachable } from "~/lib/sites.server";
import { onlyInCarrel, waitingWork } from "~/lib/waiting.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/project";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const head = {
    slug: project.slug,
    name: project.name,
    site: siteEntry(project.site).name,
    mentions: can(project.role, "read_mentions"),
    canShare: can(project.role, "manage"),
  };
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected") return { project: head, data: null, fresh: [], unavailable: `${connection.detail} Posts appear here once the site's key is set.` };
  const query = readPostQuery(new URL(request.url).searchParams);
  try {
    const [kit, writing, waiting, indexed] = await Promise.all([
      loadPosts(postsSource(env, project, viewer), query),
      kindsIn(env.DB, project.id),
      waitingWork(env.DB, project, viewer),
      searchItems(env.DB, project.id, {}),
    ]);
    // A data kind (the lab registry) is published with no page; it stays out of the writing list, as
    // the index keeps it out (index.server.ts, writingKinds). The counts then cover more than the rows, so they go.
    const isData = (r: { kind: string; status: string; path: string | null }) => !writing.includes(r.kind) && r.status === "published" && r.path === null;
    const rows = kit.rows.filter((r) => !isData(r)).map((r) => ({ ...r, notes: r.notes?.map((n) => ({ text: n.text, tone: "info" as const })) }));
    const dropped = rows.length < kit.rows.length;
    const data: PostsData = {
      ...kit,
      rows,
      kinds: kit.kinds.filter((k) => rows.some((r) => r.kind === k)),
      counts: dropped ? undefined : kit.counts,
      page: dropped ? { nextCursor: kit.page.nextCursor } : kit.page,
      ...(siteEntry(project.site).newSource !== undefined ? { newHref: `/p/${encodeURIComponent(project.slug)}/new` } : {}),
      extra: { toolbar: [{ intent: "refresh", label: "Refresh from the site" }] },
    };
    // A draft for a post the site does not have yet shows on the plain list and on Drafts, as before the kit.
    const plain = !query.trashed && !query.cursor && !query.kind && !query.tag && !query.author && !query.from && !query.to && (!query.status || query.status === "draft");
    const known = new Set([...indexed.map((i) => i.itemId), ...kit.rows.map((r) => r.id)]);
    return { project: head, data, fresh: plain ? onlyInCarrel(waiting, known, query.q) : [], unavailable: null };
  } catch (error) {
    const message = siteUnreachable(error);
    if (message === null) throw error;
    return { project: head, data: null, fresh: [], unavailable: message };
  }
}

export async function action({ params, request, context }: Route.ActionArgs): Promise<IntentResult | { share: Awaited<ReturnType<typeof shareFromForm>> }> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  if (form.get("intent") === "share") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "read");
    return { share: await shareFromForm(env, viewer, project.id, form) };
  }
  return runIntent(env, viewer, params.project, form);
}


export default function Project({ loaderData, actionData }: Route.ComponentProps) {
  const { project, data, fresh, unavailable } = loaderData;
  const base = `/p/${encodeURIComponent(project.slug)}`;
  const submit = useKitSubmit(`${base}/posts/api`);
  const result = actionData && "ok" in actionData ? actionData : null;
  return (
    <div className="app-page">
      <PageHead title={project.name} lead={`Everything on ${project.site}, as the site lists it.`} />
      <ProjectTabs slug={project.slug} current="posts" mentions={project.mentions} />

      {fresh.length > 0 ? (
        <Panel title="Only in Carrel" count={fresh.length} src="Drafts for posts the site does not have yet">
          <RowList label="Only in Carrel">
            {fresh.map((w) => (
              <Row
                key={w.itemId}
                title={w.title || w.itemId}
                href={`${base}/e/${encodeURIComponent(w.itemId)}`}
                status={<Pill variant="secondary">New draft</Pill>}
                meta={w.aiDrafts > 0 ? (w.aiDrafts === 1 ? "1 AI draft waiting" : `${w.aiDrafts} AI drafts waiting`) : "Your draft"}
              />
            ))}
          </RowList>
        </Panel>
      ) : null}

      {unavailable || !data ? (
        <Banner tone="warn" title="The site's posts cannot be listed">
          {unavailable}
        </Banner>
      ) : (
        <PostsList data={data} action={base} Form={KitForm} submit={submit} result={result} />
      )}

      {project.canShare ? <SharePanel site /> : null}
    </div>
  );
}
