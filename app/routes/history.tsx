// One item's history: its revisions from the site, newest first, each opening its source; the
// changes between any two; and the person's own working draft set against the site's text or an AI
// draft. Everything here is read-only and works for a Reader. Revision diffs are the site's own
// unified patches; the two comparisons that have both sides in Carrel build the patch here.
// "By word" sets the same two texts against each other sentence by sentence.

import { Link, useLocation, useNavigate } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { DraftCompare, DraftPatch } from "capsomer/react/draft-compare";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { DraftLinks } from "~/components/history/draft-links";
import { RevisionPicker } from "~/components/history/revision-picker";
import { PageHead } from "~/components/page-head";
import { listAiDrafts, readAiDraft } from "~/lib/ai.server";
import { readDoc, readDraft } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { listRevisions, orderPair, readRevision, revisionPatch } from "~/lib/history.server";
import { unifiedPatch } from "~/lib/patch";
import { requireSiteProject } from "~/lib/projects.server";
import { SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/history";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `History of ${data.title || data.itemId} · Carrel` : "Carrel" }];
}

type Side = { title: string; who?: string; time?: string; text: string };
type View =
  | { kind: "none" }
  | { kind: "problem"; message: string }
  | { kind: "source"; version: string; message: string; author: string; at: string; source: string; current: boolean; previous: string | null; newest: string | null }
  | { kind: "compare"; heading: string; lead: string; patch: string | null; before: Side | null; after: Side | null };

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const itemId = params.item;
  const query = new URL(request.url).searchParams;
  const by: "line" | "word" = query.get("by") === "word" ? "word" : "line";

  let doc = null;
  let revisions = null;
  let siteError: string | null = null;
  try {
    doc = await readDoc(env, project, itemId);
    revisions = await listRevisions(env, project, itemId);
  } catch (error) {
    siteError = error instanceof SiteNotConnected ? error.detail : "The site did not answer, so its history cannot be shown.";
  }
  const [draft, aiDrafts] = await Promise.all([readDraft(env.DB, project, viewer, itemId), listAiDrafts(env.DB, project, viewer, itemId)]);
  if (!doc && !draft && aiDrafts.length === 0 && !siteError) throw new Response("Not found", { status: 404 });

  const list = revisions ?? [];
  const picks = query.getAll("v");
  let view: View = { kind: "none" };
  let picked: string[] = [];

  if (query.get("compare") === "site") {
    if (!draft) view = { kind: "problem", message: "You have no working draft of this post in Carrel, so there is nothing to set against the site's text." };
    else if (!doc) view = { kind: "problem", message: siteError ?? "This post is not on the site yet, so there is no site version to compare with." };
    else {
      const before: Side = { title: "On the site", who: doc.status === "published" ? "Published" : doc.status === "scheduled" ? "Scheduled" : "Draft", time: doc.updatedAt ?? undefined, text: doc.source };
      const after: Side = { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source };
      view = sides("Your working draft against the site's version", "Your autosaved copy in Carrel, set against what the site holds now.", itemId, before, after, by);
    }
  } else if (query.get("compare") === "ai") {
    const id = Number(query.get("ai"));
    if (!Number.isInteger(id) || id <= 0) {
      view = { kind: "problem", message: "That AI draft is not one of yours for this post." };
    } else {
      const ai = await readAiDraft(env.DB, project, viewer, itemId, id);
      const mine: Side = draft
        ? { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source }
        : { title: "On the site", time: doc?.updatedAt ?? undefined, text: doc?.source ?? "" };
      const theirs: Side = { title: `AI draft from ${ai.client}`, who: ai.client, time: ai.createdAt, text: ai.source };
      view = sides(
        `Your ${draft ? "draft" : "post"} against the AI draft from ${ai.client}`,
        draft ? "Your autosaved copy in Carrel, set against the AI draft saved beside it." : "You have no working draft, so this is the site's text against the AI draft saved beside it.",
        itemId,
        mine,
        theirs,
        by,
      );
    }
  } else if (siteError) {
    view = { kind: "none" };
  } else if (query.get("version")) {
    const version = query.get("version")!;
    const at = list.findIndex((r) => r.version === version);
    if (at < 0) {
      view = { kind: "problem", message: "The site has no such revision of this post." };
    } else {
      const revision = list[at]!;
      const source = await readRevision(env, project, itemId, version);
      view =
        source === null
          ? { kind: "problem", message: "The site could not open that revision's source. A site on an older version of the site API cannot." }
          : { kind: "source", version, message: revision.message, author: revision.author, at: revision.at, source, current: at === 0, previous: list[at + 1]?.version ?? null, newest: at === 0 ? null : list[0]!.version };
    }
  } else if (picks.length > 0) {
    const pair = orderPair(list, picks);
    if (!pair) {
      view = { kind: "problem", message: "Pick two different revisions to compare." };
      picked = picks;
    } else {
      picked = [pair.from.version, pair.to.version];
      const heading = `${utc(pair.from.at)} to ${utc(pair.to.at)}`;
      const lead = `What changed on the site between the revision by ${pair.from.author} and the one by ${pair.to.author}.`;
      if (by === "line") {
        const patch = await revisionPatch(env, project, itemId, pair.from.version, pair.to.version);
        view = patch === null ? { kind: "problem", message: "The site could not give the changes between those revisions." } : { kind: "compare", heading, lead, patch, before: null, after: null };
      } else {
        const [before, after] = await Promise.all([readRevision(env, project, itemId, pair.from.version), readRevision(env, project, itemId, pair.to.version)]);
        view =
          before === null || after === null
            ? { kind: "problem", message: "The site could not open one of those revisions' source. A site on an older version of the site API cannot." }
            : {
                kind: "compare",
                heading,
                lead,
                patch: null,
                before: { title: "Earlier revision", who: pair.from.author, time: pair.from.at, text: before },
                after: { title: "Later revision", who: pair.to.author, time: pair.to.at, text: after },
              };
      }
    }
  }

  return {
    project: { slug: project.slug, name: project.name },
    itemId,
    title: doc?.title ?? "",
    by,
    view,
    picked,
    revisions: list.map((r) => ({ version: r.version, at: r.at, author: r.author, message: r.message })),
    siteError,
    againstSite: Boolean(draft && doc),
    aiDrafts: aiDrafts.map((d) => ({ id: d.id, client: d.client, createdAt: d.createdAt })),
  };
}

/** Both texts are in Carrel: the patch is built here, and the same two texts feed the word view. */
function sides(heading: string, lead: string, itemId: string, before: Side, after: Side, by: "line" | "word"): View {
  if (by === "word") return { kind: "compare", heading, lead, patch: null, before, after };
  const patch = unifiedPatch(`${itemId}.md`, { text: before.text, label: before.title }, { text: after.text, label: after.title });
  return { kind: "compare", heading, lead, patch, before: null, after: null };
}

export default function History({ loaderData }: Route.ComponentProps) {
  const { project, itemId, title, by, view, picked, revisions, siteError, aiDrafts, againstSite } = loaderData;
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  const historyPath = `${editor}/history`;
  const navigate = useNavigate();
  const location = useLocation();
  const setBy = (next: "line" | "word") => {
    const params = new URLSearchParams(location.search);
    params.set("by", next);
    void navigate(`${location.pathname}?${params.toString()}`, { preventScrollReset: true });
  };

  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: title || itemId, href: editor }, { label: "History" }]}
        title={`History of ${title || itemId}`}
        lead="What the site remembers of this post, newest first. Looking here changes nothing."
        actions={
          <Link to={editor} className="cap-btn">
            Back to the editor
          </Link>
        }
      />

      {siteError ? <Banner tone="warn">{siteError}</Banner> : null}

      {view.kind === "problem" ? <Alert tone="warn">{view.message}</Alert> : null}

      {view.kind === "source" ? (
        <Panel
          title={view.message || "Revision"}
          src={
            <>
              by {view.author}, <Time at={view.at} format="exact" />
            </>
          }
          actions={
            <>
              {view.current ? <Pill tone="ok">Current</Pill> : null}
              {view.previous ? (
                <Link className="cap-btn" to={`${historyPath}?v=${encodeURIComponent(view.previous)}&v=${encodeURIComponent(view.version)}`}>
                  Changes in this revision
                </Link>
              ) : null}
              {view.newest ? (
                <Link className="cap-btn" to={`${historyPath}?v=${encodeURIComponent(view.version)}&v=${encodeURIComponent(view.newest)}`}>
                  Compare with the current version
                </Link>
              ) : null}
            </>
          }
        >
          <pre className="app-ai-draft" aria-label="Source of this revision">
            {view.source}
          </pre>
        </Panel>
      ) : null}

      {view.kind === "compare" ? (
        <Panel
          title={view.heading}
          description={view.lead}
          actions={<Segmented legend="Compare by" hideLegend size="sm" value={by} onChange={setBy} options={[{ value: "line", label: "By line" }, { value: "word", label: "By word" }]} />}
        >
          {view.patch !== null ? <DraftPatch patch={view.patch} title={view.heading} id="history-patch" /> : view.before && view.after ? <DraftCompare before={view.before} after={view.after} id="history-compare" /> : null}
        </Panel>
      ) : null}

      {againstSite || aiDrafts.length > 0 ? (
        <Panel title="Your draft" src="Your autosaved copy in Carrel">
          <DraftLinks historyPath={historyPath} againstSite={againstSite} aiDrafts={aiDrafts} />
        </Panel>
      ) : null}

      <Panel title="Revisions" count={revisions.length} src="Saves and publishes on the site">
        {revisions.length === 0 ? (
          <Empty kind="nothing-yet" title="No history to show">
            {siteError ? "The site is not answering." : "The site has no saved revisions of this post yet."}
          </Empty>
        ) : (
          <RevisionPicker revisions={revisions} historyPath={historyPath} picked={picked} label="Revisions of this post" />
        )}
      </Panel>
    </div>
  );
}
