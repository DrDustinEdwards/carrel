// One AI draft, read-only, beside the person's own. Using it is the person's decision: "Use as my
// draft" puts its text in their working draft (autosave), where they edit it before anything reaches
// the site. Nothing here writes to the site.

import { useState } from "react";
import { redirect, useSearchParams } from "react-router";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { PreviewPane } from "capsomer/react/editor-workspace";
import { Segmented } from "capsomer/react/segmented";

import { DraftHead, draftIdParam } from "~/components/editor/draft-head";
import { FrontmatterFields } from "~/components/editor/frontmatter-fields";
import { Inspector } from "capsomer/react/inspector";
import { SearchSharingPanel } from "~/components/editor/search-sharing";

import { readAiDraft } from "~/lib/ai.server";
import { autosave } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { seoOf } from "~/lib/seo.server";
import { checkAgainstPack, readVoicePack } from "~/lib/voice.server";

import type { Route } from "./+types/ai-draft";

export function meta() {
  return [{ title: "AI draft · Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const draft = await readAiDraft(env.DB, project, viewer, params.item, draftIdParam(params.id));
  return {
    project: { slug: project.slug, name: project.name },
    itemId: params.item,
    draft: {
      id: draft.id,
      client: draft.client,
      note: draft.note,
      createdAt: draft.createdAt,
      source: draft.source,
      baseVersion: draft.baseVersion,
      sources: draft.sources,
    },
    canEdit: can(project.role, "edit"),
    // The writing checks against this project's voice pack, run on every view: the pack may have changed since it was saved.
    checks: checkAgainstPack(
      await readVoicePack(env.DB, project),
      draft.source,
      draft.sources ?? undefined,
    ),
    seo: await seoOf(env, project, draft.source, { id: params.item }),
  };
}

export async function action({ params, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const draft = await readAiDraft(env.DB, project, viewer, params.item, draftIdParam(params.id));
  await autosave(env.DB, project, viewer, params.item, {
    source: draft.source,
    baseVersion: draft.baseVersion,
  });
  return redirect(`/p/${project.slug}/e/${encodeURIComponent(params.item)}`);
}

export default function AiDraft({ loaderData }: Route.ComponentProps) {
  // `?tab=checks` opens the inspector on that tab (a link from Home's flags lands on the checks).
  const [params] = useSearchParams();
  const { project, itemId, draft, canEdit, checks, seo } = loaderData;
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  const [view, setView] = useState<"rendered" | "source">("rendered");
  return (
    <div className="app-page app-editor">
      <DraftHead
        project={project}
        itemId={itemId}
        kind="AI draft"
        draft={draft}
        use={
          canEdit
            ? {
                label: "Use as my draft",
                title: "Use the AI draft as your draft?",
                lead: "Its text replaces your working draft in Carrel, and your current draft is not kept. Nothing is sent to the site: the text waits in the editor until you save it there.",
                action: "Replace my draft",
              }
            : null
        }
        links={
          <>
            <Link to={`${editor}/history?compare=ai&ai=${draft.id}`} className="cap-btn">
              Compare with my draft
            </Link>
            <Link to={editor} className="cap-btn">
              Back to my draft
            </Link>
          </>
        }
      />
      <Banner tone="info">
        Written by an AI session, beside your own draft. It has not changed your draft or the site.
        Using it replaces your working draft in Carrel with this text, which you then edit and save
        to the site as usual.
      </Banner>
      <div className="app-editor-grid">
        <div className="app-editor-main">
          <Panel
            title="The draft"
            src={`${draft.source.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words`}
            actions={
              <Segmented
                legend="View"
                hideLegend
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: "rendered", label: "As it reads" },
                  { value: "source", label: "Source" },
                ]}
              />
            }
          >
            {view === "rendered" ? (
              <PreviewPane
                title="This AI draft as the site renders it"
                src={`${editor}/ai/${draft.id}/preview`}
              />
            ) : (
              <pre className="app-ai-draft">{draft.source}</pre>
            )}
          </Panel>
        </div>
        <Inspector
          className="app-editor-side"
          initialTab={params.get("tab")}
          label="About this AI draft"
          tabs={[
            {
              value: "details",
              label: "Details",
              content: <FrontmatterFields source={draft.source} readOnly />,
            },
            {
              value: "checks",
              label: "Checks",
              count: checks.findings.length,
              content: (
                <div className="cap-stack" data-gap="6">
                  <Panel
                    title="Writing checks"
                    count={checks.findings.length}
                    src="Against excerpts of your published posts"
                    flush
                  >
                    {checks.findings.length === 0 ? (
                      <Empty kind="all-clear" flush title="Nothing flagged">
                        Nothing reads unlike your own posts. Read it anyway: the scan catches
                        habits, not whether it says something.
                      </Empty>
                    ) : (
                      <RowList label="Writing checks on this draft">
                        {checks.findings.map((f, i) => (
                          <Row
                            key={i}
                            title={f.say}
                            detail={<q>{f.excerpt}</q>}
                            meta={f.line ? `Line ${f.line}` : undefined}
                          />
                        ))}
                      </RowList>
                    )}
                  </Panel>
                  {draft.sources?.length === 0 ? (
                    <p className="app-note">
                      The session gave no sources, so nothing in the draft can be checked against
                      one.
                    </p>
                  ) : null}
                  {draft.sources?.length ? (
                    <Panel
                      title="Sources"
                      count={draft.sources.length}
                      src="What the session says the draft drew on"
                      flush
                    >
                      <RowList label="Sources of this draft">
                        {draft.sources.map((s, i) => (
                          <Row
                            key={i}
                            title={s.split("\n")[0]!.slice(0, 160)}
                            detail={<pre className="app-ai-draft">{s}</pre>}
                          />
                        ))}
                      </RowList>
                    </Panel>
                  ) : null}
                </div>
              ),
            },
            {
              value: "search",
              label: "Search",
              content: seo ? <SearchSharingPanel check={seo} /> : null,
            },
          ]}
        />
      </div>
    </div>
  );
}
