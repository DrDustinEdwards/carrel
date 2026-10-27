// One item's history: its revisions from the site, newest first, each opening its source; the
// changes between any two; and the person's own working draft set against the site's text or an AI
// draft. Looking works for a Reader; the one write is Restore, which puts an earlier revision's text
// back on the site (published again if the post is live) for anyone who may make that write, so any
// change, an AI publish among them, can be undone from here. Revision diffs are the site's own
// unified patches; the two comparisons that have both sides in Carrel build the patch here.
// "By word" sets the same two texts against each other sentence by sentence.

import { Form, Link } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { PageHead } from "capsomer/react/page-head";

import { DraftLinks } from "~/components/history/draft-links";
import { ComparePanel, type Side, SourcePanel, sides, utc, type View } from "~/components/history/history-view";
import { RevisionPicker } from "~/components/history/revision-picker";
import { RouterLink } from "~/components/frame";
import { listAiDrafts, readAiDraft } from "~/lib/ai.server";
import { readDoc, readDraft, writeToSite } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { listRevisions, orderPair, readRevision, revisionPatch } from "~/lib/history.server";
import { kindNoun } from "~/lib/kind-words";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/history";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `History of ${data.title || data.itemId} · Carrel` : "Carrel" }];
}

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

  const noun = kindNoun(doc?.kind);
  const list = revisions ?? [];
  const picks = query.getAll("v");
  let view: View = { kind: "none" };
  let picked: string[] = [];

  if (query.get("compare") === "site") {
    if (!draft) view = { kind: "problem", message: `You have no working draft of this ${noun} in Carrel, so there is nothing to set against the site's text.` };
    else if (!doc) view = { kind: "problem", message: siteError ?? `This ${noun} is not on the site yet, so there is no site version to compare with.` };
    else {
      const before: Side = { title: "On the site", who: doc.status === "published" ? "Published" : doc.status === "scheduled" ? "Scheduled" : "Draft", time: doc.updatedAt ?? undefined, text: doc.source };
      const after: Side = { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source };
      view = sides("Your working draft against the site's version", "Your autosaved copy in Carrel, set against what the site holds now.", `${itemId}.md`, before, after, by);
    }
  } else if (query.get("compare") === "ai") {
    const id = Number(query.get("ai"));
    if (!Number.isInteger(id) || id <= 0) {
      view = { kind: "problem", message: `That AI draft is not one of yours for this ${noun}.` };
    } else {
      const ai = await readAiDraft(env.DB, project, viewer, itemId, id);
      const mine: Side = draft
        ? { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source }
        : { title: "On the site", time: doc?.updatedAt ?? undefined, text: doc?.source ?? "" };
      const theirs: Side = { title: `AI draft from ${ai.client}`, who: ai.client, time: ai.createdAt, text: ai.source };
      view = sides(
        `Your ${draft ? "draft" : noun} against the AI draft from ${ai.client}`,
        draft ? "Your autosaved copy in Carrel, set against the AI draft saved beside it." : "You have no working draft, so this is the site's text against the AI draft saved beside it.",
        `${itemId}.md`,
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
      view = { kind: "problem", message: `The site has no such revision of this ${noun}.` };
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
    noun,
    by,
    view,
    picked,
    revisions: list.map((r) => ({ version: r.version, at: r.at, author: r.author, message: r.message })),
    siteError,
    againstSite: Boolean(draft && doc),
    aiDrafts: aiDrafts.map((d) => ({ id: d.id, client: d.client, createdAt: d.createdAt })),
    canRestore: Boolean(doc && can(project.role, restoreNeeds(doc.status))),
  };
}

/** A live post's earlier text goes back live; a draft's goes back as the site's draft. */
const restoreNeeds = (status: string) => (status === "draft" ? "edit" : "publish");

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const form = await request.formData();
  const version = String(form.get("version") ?? "");
  const doc = await readDoc(env, project, params.item);
  if (!doc || !version) throw new Response("Not found", { status: 404 });
  if (!can(project.role, restoreNeeds(doc.status))) throw new Response("Forbidden", { status: 403 });
  const source = await readRevision(env, project, params.item, version);
  if (source === null) return { ok: false as const, message: "The site could not open that revision's source." };
  const outcome = await writeToSite(
    env,
    project,
    viewer,
    params.item,
    doc.status === "draft" ? { action: "save", source, expectedVersion: doc.version } : { action: "publish", source, expectedVersion: doc.version },
    undefined,
    { keepDraft: true },
  );
  return outcome.ok
    ? { ok: true as const, message: doc.status === "draft" ? "Restored as the site's draft." : "Restored and published." }
    : { ok: false as const, message: outcome.message };
}

export default function History({ loaderData, actionData }: Route.ComponentProps) {
  const { project, itemId, title, noun, by, view, picked, revisions, siteError, aiDrafts, againstSite, canRestore } = loaderData;
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  const historyPath = `${editor}/history`;

  return (
    <div className="app-page">
      <PageHead
        renderLink={RouterLink}
        crumbs={[{ label: project.name, href: `/p/${project.slug}` }, { label: title || itemId, href: editor }, { label: "History" }]}
        title={`History of ${title || itemId}`}
        lead={`What the site remembers of this ${noun}, newest first. Looking here changes nothing.`}
        actions={
          <Link to={editor} className="cap-btn">
            Back to the editor
          </Link>
        }
      />

      {siteError ? <Banner tone="warn">{siteError}</Banner> : null}

      {view.kind === "problem" ? <Alert tone="warn">{view.message}</Alert> : null}
      {actionData ? actionData.ok ? <Banner tone="ok">{actionData.message}</Banner> : <Alert tone="crit">{actionData.message}</Alert> : null}

      {view.kind === "source" ? (
        <SourcePanel
          view={view}
          historyPath={historyPath}
          noun="revision"
          restore={
            !view.current && canRestore ? (
              <Form method="post">
                <input type="hidden" name="version" value={view.version} />
                <Button type="submit">Restore this version</Button>
              </Form>
            ) : null
          }
        />
      ) : null}

      {view.kind === "compare" ? <ComparePanel view={view} by={by} id="history" options={[{ value: "line", label: "By line" }, { value: "word", label: "By word" }]} /> : null}

      {againstSite || aiDrafts.length > 0 ? (
        <Panel title="Your draft" src="Your autosaved copy in Carrel">
          <DraftLinks historyPath={historyPath} againstSite={againstSite} aiDrafts={aiDrafts} />
        </Panel>
      ) : null}

      <Panel title="Revisions" count={revisions.length} src="Saves and publishes on the site">
        {revisions.length === 0 ? (
          <Empty kind="nothing-yet" title="No history to show">
            {siteError ? "The site is not answering." : `The site has no saved revisions of this ${noun} yet.`}
          </Empty>
        ) : (
          <RevisionPicker revisions={revisions} historyPath={historyPath} picked={picked} label={`Revisions of this ${noun}`} />
        )}
      </Panel>
    </div>
  );
}
