// One book file's history (job_b4555715afcf), the twin of the site posts' history page: its versions
// newest first (saved in Carrel, moved in the binder, or committed elsewhere), each opening its text;
// any two set side by side or as a patch; and the person's own text against Git's or against an AI
// draft saved beside it. Read-only, and it works for a Reader. The compare components and the patch
// are the site page's.

import { Link, useLocation, useNavigate, useNavigation } from "react-router";
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
import { bookVersions, readVersion } from "~/lib/book-history.server";
import { bookRepo, indexedFile, requireBookProject } from "~/lib/books.server";
import { readDraft } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { orderPair } from "~/lib/history.server";
import { isBookPath, kindOf, titleFromSegment } from "~/lib/novels/layout";
import { unifiedPatch } from "~/lib/patch";

import type { Route } from "./+types/book.history";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `History of ${data.label} · ${data.project.name} · Carrel` : "Carrel" }];
}

type Side = { title: string; who?: string; time?: string; text: string };
type View =
  | { kind: "none" }
  | { kind: "problem"; message: string }
  | { kind: "source"; version: string; message: string; author: string; at: string; source: string; current: boolean; previous: string | null; newest: string | null }
  | { kind: "compare"; heading: string; lead: string; patch: string | null; before: Side | null; after: Side | null };

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function labelFor(path: string): string {
  const file = titleFromSegment(path.split("/").pop()!.replace(/\.md$/, ""));
  if (kindOf(path) === "scene") return `${titleFromSegment(path.split("/")[1]!)}: ${file}`;
  if (kindOf(path) === "book") return "Title page";
  return file;
}

/** Both texts are in hand: line by line is a patch built here, word by word the two texts side by side. */
function sides(heading: string, lead: string, path: string, before: Side, after: Side, by: "line" | "word"): View {
  if (by === "word") return { kind: "compare", heading, lead, patch: null, before, after };
  return { kind: "compare", heading, lead, patch: unifiedPatch(path.split("/").pop()!, { text: before.text, label: before.title }, { text: after.text, label: after.title }), before: null, after: null };
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const path = params["*"] ?? "";
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });
  const query = new URL(request.url).searchParams;
  // Side by side unless the person asks for the patch.
  const by: "line" | "word" = query.get("by") === "line" ? "line" : "word";

  const { repo, detail } = bookRepo(env);
  const [{ versions, gitError }, draft, aiDrafts, indexed] = await Promise.all([
    bookVersions(env.DB, repo, project, path),
    readDraft(env.DB, project, viewer, path),
    listAiDrafts(env.DB, project, viewer, path),
    indexedFile(env.DB, project, path),
  ]);
  if (!indexed && versions.length === 0 && !draft && aiDrafts.length === 0) throw new Response("Not found", { status: 404 });
  let current: string | null = indexed?.source ?? null;
  if (repo) {
    try {
      current = (await repo.read(`${project.book}/${path}`))?.source ?? current;
    } catch {
      // The index's copy stands in; the problem is already said for the list.
    }
  }
  const unread = repo ? null : `${detail} Without Git, only the versions Carrel recorded are listed, and their text cannot be opened.`;

  const picks = query.getAll("v");
  let view: View = { kind: "none" };
  let picked: string[] = [];
  const read = async (v: (typeof versions)[number]) => (repo ? readVersion(repo, project, v) : null);

  if (query.get("compare") === "git") {
    if (!draft) view = { kind: "problem", message: "You have no working draft of this file in Carrel, so there is nothing to set against Git's text." };
    else if (current === null) view = { kind: "problem", message: "This file is not in Git yet, so there is no saved version to compare with." };
    else {
      view = sides(
        "Your working draft against the saved file",
        "Your autosaved copy in Carrel, set against the file as Git holds it now.",
        path,
        { title: "Saved in Git", text: current },
        { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source },
        by,
      );
    }
  } else if (query.get("compare") === "ai") {
    const id = Number(query.get("ai"));
    if (!Number.isInteger(id) || id <= 0) view = { kind: "problem", message: "That AI draft is not one of yours for this file." };
    else {
      const ai = await readAiDraft(env.DB, project, viewer, path, id);
      const mine: Side = draft
        ? { title: "Your working draft", who: viewer.name, time: draft.updatedAt, text: draft.source }
        : { title: "Your text, saved in Git", text: current ?? "" };
      view = sides(
        `Your ${draft ? "draft" : "text"} against the AI draft from ${ai.client}`,
        draft ? "Your autosaved copy in Carrel, set against the AI draft saved beside it." : "You have no working draft, so this is the saved file against the AI draft saved beside it.",
        path,
        mine,
        { title: `AI draft from ${ai.client}`, who: ai.client, time: ai.createdAt, text: ai.source },
        by,
      );
    }
  } else if (query.get("version")) {
    const at = versions.findIndex((v) => v.version === query.get("version"));
    if (at < 0) view = { kind: "problem", message: "This file has no such version." };
    else {
      const v = versions[at]!;
      const source = await read(v);
      view =
        source === null
          ? { kind: "problem", message: unread ?? "Git does not hold this file at that version." }
          : { kind: "source", version: v.version, message: v.message, author: v.author, at: v.at, source, current: at === 0, previous: versions[at + 1]?.version ?? null, newest: at === 0 ? null : versions[0]!.version };
    }
  } else if (picks.length > 0) {
    const pair = orderPair(versions, picks);
    picked = picks;
    if (!pair) view = { kind: "problem", message: "Pick two different versions to compare." };
    else {
      picked = [pair.from.version, pair.to.version];
      const [before, after] = await Promise.all([read(pair.from), read(pair.to)]);
      view =
        before === null || after === null
          ? { kind: "problem", message: unread ?? "Git does not hold the file at one of those versions." }
          : sides(
              `${utc(pair.from.at)} to ${utc(pair.to.at)}`,
              `What changed between the version by ${pair.from.author} and the one by ${pair.to.author}.`,
              path,
              { title: "Earlier version", who: pair.from.author, time: pair.from.at, text: before },
              { title: "Later version", who: pair.to.author, time: pair.to.at, text: after },
              by,
            );
    }
  }

  return {
    project: { slug: project.slug, name: project.name },
    path,
    label: labelFor(path),
    by,
    view,
    picked,
    versions: versions.map((v) => ({ version: v.version, at: v.at, author: v.author, message: v.message, kind: v.kind, path: v.path })),
    notice: gitError ?? unread,
    againstGit: Boolean(draft && current !== null),
    aiDrafts: aiDrafts.map((d) => ({ id: d.id, client: d.client, createdAt: d.createdAt })),
  };
}

export default function BookHistory({ loaderData }: Route.ComponentProps) {
  const { project, path, label, by, view, picked, versions, notice, againstGit, aiDrafts } = loaderData;
  const base = `/b/${project.slug}`;
  const editor = `${base}/f/${path}`;
  const historyPath = `${base}/h/${path}`;
  const navigate = useNavigate();
  const location = useLocation();
  const pending = useNavigation().location;
  const shown = pending ? (new URLSearchParams(pending.search).get("by") === "line" ? "line" : "word") : by;
  const setBy = (next: "line" | "word") => {
    const params = new URLSearchParams(location.search);
    params.set("by", next);
    void navigate(`${location.pathname}?${params.toString()}`, { preventScrollReset: true });
  };
  const moved = versions.filter((v) => v.path !== path).length;

  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: base }, { label, href: editor }, { label: "History" }]}
        title={`History of ${label}`}
        lead={
          <>
            Every version of <span className="cap-mono">{path}</span>, newest first{moved ? ", followed back through its moves" : ""}. Looking here changes nothing.
          </>
        }
        actions={
          <Link to={editor} className="cap-btn">
            Back to the editor
          </Link>
        }
      />

      {notice ? <Banner tone="warn">{notice}</Banner> : null}
      {view.kind === "problem" ? <Alert tone="warn">{view.message}</Alert> : null}

      {view.kind === "source" ? (
        <Panel
          title={view.message}
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
                  Changes in this version
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
          <pre className="app-ai-draft" aria-label="Text of this version">
            {view.source}
          </pre>
        </Panel>
      ) : null}

      {view.kind === "compare" ? (
        <Panel
          title={view.heading}
          description={view.lead}
          actions={<Segmented legend="Compare by" hideLegend size="sm" value={shown} onChange={setBy} options={[{ value: "word", label: "Side by side" }, { value: "line", label: "By line" }]} />}
        >
          {view.patch !== null ? <DraftPatch patch={view.patch} title={view.heading} id="book-history-patch" /> : view.before && view.after ? <DraftCompare before={view.before} after={view.after} id="book-history-compare" /> : null}
        </Panel>
      ) : null}

      {againstGit || aiDrafts.length > 0 ? (
        <Panel title="Your text" src="Your draft, or the saved file when you have none">
          {againstGit ? (
            <ul className="app-flags" aria-label="Compare your draft with the saved file">
              <li>
                <span>
                  <Link to={`${historyPath}?compare=git`}>Your working draft against the saved file</Link>
                </span>
              </li>
            </ul>
          ) : null}
          <DraftLinks historyPath={historyPath} againstSite={false} aiDrafts={aiDrafts} />
        </Panel>
      ) : null}

      <Panel title="Versions" count={versions.length} src="Saved in Carrel, moved in the binder, or committed elsewhere">
        {versions.length === 0 ? (
          <Empty kind="nothing-yet" title="No history to show">
            {notice ? "Git is not answering." : "Nothing has been saved to this file yet."}
          </Empty>
        ) : (
          <RevisionPicker
            revisions={versions.map((v) => ({ ...v, message: v.kind === "outside" ? `${v.message} (outside Carrel)` : v.message }))}
            historyPath={historyPath}
            picked={picked}
            label="Versions of this file"
          />
        )}
      </Panel>
    </div>
  );
}
