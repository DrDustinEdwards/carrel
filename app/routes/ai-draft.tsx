// One AI draft, read-only, beside the person's own. Using it is the person's decision: "Use as my
// draft" puts its text in their working draft (autosave), where they edit it before anything reaches
// the site. Nothing here writes to the site.

import { useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Panel } from "capsomer/react/panel";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";

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
  const busy = useNavigation().state !== "idle";
  const [asking, setAsking] = useState<HTMLElement | null>(null);
  const form = useRef<HTMLFormElement>(null);
  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: itemId, href: editor }, { label: "AI draft" }]}
        title={`AI draft from ${draft.client}`}
        lead={
          <>
            Saved <Time at={draft.createdAt} format="exact" />
            {draft.note ? ` · ${draft.note}` : ""}
          </>
        }
        actions={
          <>
            {canEdit ? (
              <Form method="post" ref={form}>
                <Button
                  type="submit"
                  variant="primary"
                  pending={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    setAsking(event.currentTarget);
                  }}
                >
                  Use as my draft
                </Button>
              </Form>
            ) : null}
            <Link to={editor} className="cap-btn">
              Back to my draft
            </Link>
          </>
        }
      />
      <Banner tone="info">
        Written by an AI session, beside your own draft. It has not changed your draft or the site. Using it replaces your working draft with this text, which you then edit and
        save as usual.
      </Banner>
      <Panel title="The draft" src={`${draft.source.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words`}>
        <pre className="app-ai-draft">{draft.source}</pre>
      </Panel>
      <ConfirmDialog
        open={asking !== null}
        title="Use the AI draft as your draft?"
        lead="Its text replaces your working draft. Your current draft is not kept."
        body={[]}
        action="Replace my draft"
        returnTo={asking}
        perform={async () => {
          // Submitting the form itself does not press the button again, so it does not ask twice.
          form.current?.requestSubmit();
        }}
        onClose={() => setAsking(null)}
      />
    </div>
  );
}
