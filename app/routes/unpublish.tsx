// Where the email after an AI publish sends Dustin: the post, who published it, and one button that
// returns it to draft. The link opens this page rather than unpublishing on its own, because a GET
// that changed the site could be set off by anything that fetches links (a mail client's preview).

import { Form, Link } from "react-router";

import { lastAiPublication, publishedByLine } from "~/lib/ai.server";
import { readDoc, writeToSite } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/unpublish";

export function meta() {
  return [{ title: "Unpublish · Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "publish");
  const doc = await readDoc(env, project, params.item);
  if (!doc) throw new Response("Not found", { status: 404 });
  const ai = await lastAiPublication(env.DB, project, params.item);
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    item: { id: doc.id, title: doc.title || doc.id, status: doc.status, path: doc.path, version: doc.version },
    publishedBy: ai ? { line: publishedByLine(ai.client), at: ai.publishedAt } : null,
  };
}

export async function action({ params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "publish");
  const doc = await readDoc(env, project, params.item);
  if (!doc) throw new Response("Not found", { status: 404 });
  if (doc.status === "draft") return { ok: true as const, already: true, message: "It is already a draft." };
  const outcome = await writeToSite(env, project, viewer, params.item, { action: "unpublish", expectedVersion: doc.version });
  return outcome.ok ? { ok: true as const, already: false, message: "Returned to draft. It is off the site." } : { ok: false as const, already: false, message: outcome.message };
}

export default function Unpublish({ loaderData, actionData }: Route.ComponentProps) {
  const { project, item, publishedBy } = loaderData;
  const done = actionData?.ok;
  return (
    <main className="shell">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={`/p/${project.slug}`}>{project.name}</Link>
        </p>
        <h1>{item.title}</h1>
        <p className="muted">
          <span className={`status status-${item.status}`}>{item.status}</span> on {project.site}
          {item.path ? ` at ${item.path}` : ""}
        </p>
      </header>
      {publishedBy ? (
        <p>
          {publishedBy.line} <span className="muted">({new Date(publishedBy.at).toLocaleString()})</span>
        </p>
      ) : null}
      {actionData ? (
        <p className={actionData.ok ? "muted" : "alarm"} role={actionData.ok ? "status" : "alert"}>
          {actionData.message}
        </p>
      ) : null}
      {!done && item.status !== "draft" ? (
        <Form method="post">
          <button type="submit" className="btn-danger" autoFocus>
            Unpublish now
          </button>
        </Form>
      ) : null}
      <p>
        <Link to={`/p/${project.slug}/e/${encodeURIComponent(item.id)}`}>Open it in the editor</Link>
      </p>
    </main>
  );
}
