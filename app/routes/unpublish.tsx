// Where the email after an AI publish sends Dustin: the post, who published it, and one button that
// returns it to draft. The link opens this page rather than unpublishing on its own, because a GET
// that changed the site could be set off by anything that fetches links (a mail client's preview).

import { Form, useNavigation } from "react-router";
import { ButtonLink, routerRenderLink } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { ActionResult } from "~/components/action-result";
import { ItemStatus } from "~/components/item-status";
import { lastAiPublication, publishedByLine } from "~/lib/ai.server";
import { mayPublishItem, readDoc, writeToSite } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteHead } from "~/lib/sites.server";

import type { Route } from "./+types/unpublish";

export function meta() {
  return [{ title: "Unpublish · Carrel" }];
}

/** The live post, for the Owner or its Author (roles.ts); anyone else is refused before the site is read. */
async function openPost({ params, context }: Route.LoaderArgs | Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "publish_own");
  if (!(await mayPublishItem(env.DB, project, viewer, params.item)))
    throw new Response("Forbidden", { status: 403 });
  const doc = await readDoc(env, project, params.item);
  if (!doc) throw new Response("Not found", { status: 404 });
  return { env, viewer, project, doc };
}

export async function loader(args: Route.LoaderArgs) {
  const { env, project, doc } = await openPost(args);
  const { params } = args;
  const ai = await lastAiPublication(env.DB, project, params.item);
  return {
    project: { ...siteHead(project) },
    item: {
      id: doc.id,
      title: doc.title || doc.id,
      status: doc.status,
      path: doc.path,
      version: doc.version,
    },
    publishedBy: ai ? { line: publishedByLine(ai.client, ai.person), at: ai.publishedAt } : null,
  };
}

export async function action(args: Route.ActionArgs) {
  const { env, viewer, project, doc } = await openPost(args);
  const { params } = args;
  if (doc.status === "draft")
    return { ok: true as const, already: true, message: "It is already a draft." };
  const outcome = await writeToSite(env, project, viewer, params.item, {
    action: "unpublish",
    expectedVersion: doc.version,
  });
  return outcome.ok
    ? { ok: true as const, already: false, message: "Returned to draft. It is off the site." }
    : { ok: false as const, already: false, message: outcome.message };
}

export default function Unpublish({ loaderData, actionData }: Route.ComponentProps) {
  const { project, item, publishedBy } = loaderData;
  const done = actionData?.ok;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="cap-admin-page" data-width="narrow">
      <PageHead
        renderLink={routerRenderLink}
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: item.title }]}
        title={item.title}
      />
      <div className="cap-cluster" data-gap="3">
        <ItemStatus status={item.status} />
        <span>{project.site}</span>
        {item.path ? <span className="cap-mono">{item.path}</span> : null}
      </div>
      {publishedBy ? (
        <Banner tone="info">
          {publishedBy.line} <Time at={publishedBy.at} format="exact" />
        </Banner>
      ) : null}
      <ActionResult result={actionData} />
      <div className="cap-cluster" data-gap="3">
        {!done && item.status !== "draft" ? (
          <Form method="post">
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the page exists only to confirm this one action, so focus starts on it */}
            <Button type="submit" variant="danger" pending={busy} autoFocus>
              Unpublish now
            </Button>
          </Form>
        ) : null}
        <ButtonLink to={`/p/${project.slug}/e/${encodeURIComponent(item.id)}`}>
          Open it in the editor
        </ButtonLink>
      </div>
    </div>
  );
}
