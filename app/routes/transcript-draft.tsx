// One transcript draft of an episode, read only, beside the site's transcript: the cues whose words it changes, and how
// many it adds, removes or retimes. Publish puts it live as the episode's transcript (site-api v0.36.0) for someone who
// may publish the episode; the transcript it replaces is kept as a draft of its own, so a publish can be put back.

import { redirect, useSearchParams } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { timecode } from "capsomer/behavior/time";

import { DraftHead, draftIdParam } from "~/components/editor/draft-head";
import { mayPublishItem } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { SiteNotConnected } from "~/lib/sites.server";
import {
  compareTranscriptDraft,
  publishTranscriptDraft,
  readTranscriptDraft,
  TranscriptRefusal,
} from "~/lib/transcripts.server";

import type { Route } from "./+types/transcript-draft";

export function meta() {
  return [{ title: "Transcript draft · Carrel" }];
}

/** The episode's project, the person and the draft's id. Both steps open the project to read: publishing checks its own right. */
async function opened({ params, context }: Pick<Route.LoaderArgs, "params" | "context">) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  return { env, viewer, project, id: draftIdParam(params.id) };
}

export async function loader(args: Route.LoaderArgs) {
  const { params } = args;
  const { env, viewer, project, id } = await opened(args);
  const draft = await readTranscriptDraft(env.DB, project, viewer, params.item, id);
  let compared = null;
  let siteError: string | null = null;
  try {
    compared = await compareTranscriptDraft(env, project, draft, params.item);
  } catch (error) {
    siteError =
      error instanceof TranscriptRefusal
        ? error.message
        : error instanceof SiteNotConnected
          ? error.detail
          : "The site did not answer, so the draft cannot be compared with its transcript.";
  }
  return {
    compared,
    siteError,
    canPublish: await mayPublishItem(env.DB, project, viewer, params.item),
    project: { slug: project.slug, name: project.name },
    itemId: params.item,
    draft: { id: draft.id, client: draft.client, note: draft.note, createdAt: draft.createdAt },
  };
}

export async function action(args: Route.ActionArgs) {
  const { params } = args;
  const { env, viewer, project, id } = await opened(args);
  try {
    const done = await publishTranscriptDraft(env, project, viewer, params.item, id);
    return redirect(
      `/p/${project.slug}/e/${encodeURIComponent(params.item)}/transcript/${done.keptDraftId}?published=${id}`,
    );
  } catch (error) {
    if (error instanceof TranscriptRefusal) return { refused: error.message };
    throw error;
  }
}

export default function TranscriptDraft({ loaderData, actionData }: Route.ComponentProps) {
  const { project, itemId, draft, compared, siteError, canPublish } = loaderData;
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  const published = useSearchParams()[0].get("published");
  const changes = compared?.changes;
  const moved = changes ? changes.added + changes.removed + changes.retimed : 0;
  return (
    <div className="app-page">
      <DraftHead
        project={project}
        itemId={itemId}
        kind="Transcript draft"
        draft={draft}
        use={
          canPublish && compared?.current
            ? {
                label: "Publish this transcript",
                title: "Publish this transcript?",
                lead: "It replaces the episode's transcript on the site at once. The post's text and version stay as they are, and the transcript it replaces is kept as a draft you can publish to put it back.",
                action: "Publish the transcript",
              }
            : null
        }
        links={<ButtonLink to={editor}>Back to the episode</ButtonLink>}
      />
      {published ? (
        <Banner tone="ok">
          Transcript draft {published} is live. This is the transcript it replaced: publish it to
          put it back.
        </Banner>
      ) : null}
      {actionData?.refused ? <Banner tone="crit">{actionData.refused}</Banner> : null}
      {siteError ? <Banner tone="warn">{siteError}</Banner> : null}
      {compared && !compared.current ? (
        <Banner tone="warn">
          The site&apos;s transcript changed after this draft was saved, so it cannot be published.
          The changes below are against the transcript as it is now.
        </Banner>
      ) : (
        <Banner tone="info">
          A whole transcript kept beside the site&apos;s. It has not changed the site. Publishing it
          replaces the episode&apos;s transcript at once; the one it replaces is kept here as a
          draft that puts it back.
        </Banner>
      )}
      {changes && moved > 0 ? (
        <Banner tone="warn">
          It also adds {changes.added}, removes {changes.removed} and retimes {changes.retimed} cue
          {moved === 1 ? "" : "s"}. Chapters and key moments point at cue times, so check them after
          publishing.
        </Banner>
      ) : null}
      {changes ? (
        <Panel
          title="Changed cues"
          count={changes.textChanged}
          src={`Of ${changes.cues.toLocaleString()} cues${changes.changed.length < changes.textChanged ? `, the first ${changes.changed.length} listed` : ""}`}
          flush
        >
          {changes.changed.length === 0 ? (
            <Empty kind="nothing-yet" flush title="No words changed">
              The draft&apos;s cues say what the site&apos;s say.
            </Empty>
          ) : (
            <RowList label="Cues this draft changes">
              {changes.changed.map((c) => (
                <Row
                  key={c.cue}
                  title={c.after}
                  detail={
                    <>
                      Was: <del>{c.before}</del>
                    </>
                  }
                  meta={`${timecode(c.at * 1000)} · cue ${c.cue}`}
                />
              ))}
            </RowList>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
