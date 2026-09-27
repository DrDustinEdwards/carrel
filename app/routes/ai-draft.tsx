// One AI draft, read-only, beside the person's own. Using it is the person's decision: "Use as my
// draft" puts its text in their working draft (autosave), where they edit it before anything reaches
// the site. Nothing here writes to the site.

import { Form, Link, redirect } from "react-router";

import { readAiDraft } from "~/lib/ai.server";
import { autosave } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";

import type { Route } from "./+types/ai-draft";

export function meta() {
  return [{ title: "AI draft · Carrel" }];
}

function draftId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Response("Not found", { status: 404 });
  return id;
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const draft = await readAiDraft(env.DB, project, viewer, params.item, draftId(params.id));
  return {
    project: { slug: project.slug, name: project.name },
    itemId: params.item,
    draft: { id: draft.id, client: draft.client, note: draft.note, createdAt: draft.createdAt, source: draft.source, baseVersion: draft.baseVersion },
    canEdit: can(project.role, "edit"),
  };
}

export async function action({ params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const draft = await readAiDraft(env.DB, project, viewer, params.item, draftId(params.id));
  await autosave(env.DB, project, viewer, params.item, { source: draft.source, baseVersion: draft.baseVersion });
  return redirect(`/p/${project.slug}/e/${encodeURIComponent(params.item)}`);
}

export default function AiDraft({ loaderData }: Route.ComponentProps) {
  const { project, itemId, draft, canEdit } = loaderData;
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={`/p/${project.slug}`}>{project.name}</Link> / <Link to={editor}>{itemId}</Link>
        </p>
        <h1>AI draft from {draft.client}</h1>
        <p className="muted">
          Saved {new Date(draft.createdAt).toLocaleString()}
          {draft.note ? ` · ${draft.note}` : ""}
        </p>
      </header>
      <p className="notice">
        Written by an AI session, beside your own draft. It has not changed your draft or the site. Using it replaces your working draft
        with this text, which you then edit and save as usual.
      </p>
      <pre className="ai-draft-text">{draft.source}</pre>
      <div className="actions">
        {canEdit ? (
          <Form method="post">
            <button type="submit" className="btn">
              Use as my draft
            </button>
          </Form>
        ) : null}
        <Link to={editor} className="btn-ghost">
          Back to my draft
        </Link>
      </div>
    </main>
  );
}
