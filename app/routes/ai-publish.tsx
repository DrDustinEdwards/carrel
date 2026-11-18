// Where an AI session's ask to publish sends the person who asked (the publishing review, finding 1): what would go
// live, from which client, and Publish or Decline. AI-written text and a first publication go live only from here, so
// text that steers a session cannot put itself on a site. The link opens this page rather than publishing on its own,
// because a GET that changed the site could be set off by anything that fetches links (a mail client's preview).

import { Form, useNavigation } from "react-router";
import { ButtonLink, routerRenderLink } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { ActionResult } from "~/components/action-result";
import { draftIdParam } from "~/components/editor/draft-head";
import { decideAiPublish, readAiPublishRequest } from "~/lib/ai.server";
import { readDoc } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { carrelOrigin } from "~/lib/mcp/server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/ai-publish";

export function meta() {
  return [{ title: "Publish request · Carrel" }];
}

/** The ask, for the Owner who made it through their AI session; anyone else is answered 404 or 403. */
async function openRequest({ params, context }: Route.LoaderArgs | Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "publish");
  const request = await readAiPublishRequest(
    env.DB,
    project,
    viewer,
    params.item,
    draftIdParam(params.id),
  );
  return { env, viewer, project, request };
}

export async function loader(args: Route.LoaderArgs) {
  const { env, project, request } = await openRequest(args);
  const doc = await readDoc(env, project, request.itemId).catch(() => null);
  const base = `/p/${encodeURIComponent(project.slug)}/e/${encodeURIComponent(request.itemId)}`;
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    title: doc?.title || request.itemId,
    editorHref: base,
    request: {
      client: request.client,
      createdAt: request.createdAt,
      outcome: request.outcome,
      decidedAt: request.decidedAt,
      // What would go live, and where to read it first.
      what:
        request.aiDraftId !== null
          ? { label: `AI draft ${request.aiDraftId}`, href: `${base}/ai/${request.aiDraftId}` }
          : request.transcriptDraftId !== null
            ? {
                label: `Transcript draft ${request.transcriptDraftId}`,
                href: `${base}/transcript/${request.transcriptDraftId}`,
              }
            : { label: "The post as it stands on the site, for the first time", href: base },
      current: doc?.version === request.expectedVersion,
    },
  };
}

export async function action(args: Route.ActionArgs) {
  const { env, viewer, project, request } = await openRequest(args);
  const decision =
    (await args.request.formData()).get("intent") === "publish" ? "publish" : "decline";
  return decideAiPublish(env, project, viewer, request, decision, {
    carrelOrigin: carrelOrigin(env),
  });
}

export default function AiPublish({ loaderData, actionData }: Route.ComponentProps) {
  const { project, title, editorHref, request } = loaderData;
  const busy = useNavigation().state !== "idle";
  const open = request.outcome === null && !actionData?.ok;
  return (
    <div className="cap-admin-page" data-width="narrow">
      <PageHead
        renderLink={routerRenderLink}
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: title }]}
        title={`Publish "${title}"?`}
      />
      {request.outcome !== null && !actionData ? (
        <Banner tone="info">
          {request.outcome === "published" ? "Published" : "Declined"}{" "}
          {request.decidedAt ? <Time at={request.decidedAt} format="exact" /> : null}
        </Banner>
      ) : null}
      <ActionResult result={actionData} />
      {open && !request.current ? (
        <Alert tone="warn">
          The post changed on the site since this was asked, so Publish will be refused. Ask again
          from the current version.
        </Alert>
      ) : null}
      <p>
        <a href={request.what.href}>{request.what.label}</a>
      </p>
      <div className="cap-cluster" data-gap="3">
        {open ? (
          <Form method="post" className="cap-cluster" data-gap="3">
            <Button type="submit" name="intent" value="publish" variant="primary" pending={busy}>
              Publish
            </Button>
            <Button type="submit" name="intent" value="decline" pending={busy}>
              Decline
            </Button>
          </Form>
        ) : null}
        <ButtonLink to={editorHref}>Open it in the editor</ButtonLink>
      </div>
    </div>
  );
}
