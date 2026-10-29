// Where the email after an AI publish sends Dustin: the post, who published it, and one button that
// returns it to draft. The link opens this page rather than unpublishing on its own, because a GET
// that changed the site could be set off by anything that fetches links (a mail client's preview).

import { Form, Link, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { RouterLink } from "~/components/frame";

import { lastAiPublication, publishedByLine } from "~/lib/ai.server";
import { mayPublishItem, readDoc, writeToSite } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/unpublish";

export function meta() {
  return [{ title: "Unpublish · Carrel" }];
}

/** The live post, for the Owner or its Author (roles.ts); anyone else is refused before the site is read. */
async function openPost({ params, context }: Route.LoaderArgs | Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "publish_own");
  if (!(await mayPublishItem(env.DB, project, viewer, params.item))) throw new Response("Forbidden", { status: 403 });
  const doc = await readDoc(env, project, params.item);
  if (!doc) throw new Response("Not found", { status: 404 });
  return { env, viewer, project, doc };
}

export async function loader(args: Route.LoaderArgs) {
  const { env, project, doc } = await openPost(args);
  const { params } = args;
  const ai = await lastAiPublication(env.DB, project, params.item);
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    item: { id: doc.id, title: doc.title || doc.id, status: doc.status, path: doc.path, version: doc.version },
    publishedBy: ai ? { line: publishedByLine(ai.client), at: ai.publishedAt } : null,
  };
}

export async function action(args: Route.ActionArgs) {
  const { env, viewer, project, doc } = await openPost(args);
  const { params } = args;
  if (doc.status === "draft") return { ok: true as const, already: true, message: "It is already a draft." };
  const outcome = await writeToSite(env, project, viewer, params.item, { action: "unpublish", expectedVersion: doc.version });
  return outcome.ok ? { ok: true as const, already: false, message: "Returned to draft. It is off the site." } : { ok: false as const, already: false, message: outcome.message };
}

export default function Unpublish({ loaderData, actionData }: Route.ComponentProps) {
  const { project, item, publishedBy } = loaderData;
  const done = actionData?.ok;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="app-page" data-narrow>
      <PageHead
        renderLink={RouterLink}
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: item.title }]}
        title={item.title}
        lead={
          <>
            {item.status === "published" ? <Pill tone="ok">Published</Pill> : item.status === "scheduled" ? <Pill tone="info">Scheduled</Pill> : <Pill variant="secondary">Draft</Pill>} on {project.site}
            {item.path ? <span className="cap-mono"> {item.path}</span> : null}
          </>
        }
      />
      {publishedBy ? (
        <Banner tone="info">
          {publishedBy.line} <Time at={publishedBy.at} format="exact" />
        </Banner>
      ) : null}
      {actionData ? actionData.ok ? <Banner tone="ok">{actionData.message}</Banner> : <Alert tone="crit">{actionData.message}</Alert> : null}
      <div className="app-actions">
        {!done && item.status !== "draft" ? (
          <Form method="post">
            <Button type="submit" variant="danger" pending={busy} autoFocus>
              Unpublish now
            </Button>
          </Form>
        ) : null}
        <Link className="cap-btn" to={`/p/${project.slug}/e/${encodeURIComponent(item.id)}`}>
          Open it in the editor
        </Link>
      </div>
    </div>
  );
}
