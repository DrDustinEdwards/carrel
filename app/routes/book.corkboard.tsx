// The corkboard (design 4.2): the book's chapters in order, then each chapter's scenes as cards with
// the summary, point of view, status and words. Chapters and cards move by dragging a grip, by the
// keyboard, or by Move up and Move down; a card also moves to another chapter. Every move is renames
// of numbered files in one commit (lib/binder.server.ts). It works with no script: the lists sit in
// forms whose buttons post the move.

import { Form, Link, useFetcher } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { SortableList, moveId } from "capsomer/react/sortable-list";

import { PageHead } from "~/components/page-head";
import { StatusLabelPill } from "~/components/writing/status-label";

import { reorderBook, chapterSources, type ReorderResult } from "~/lib/binder.server";
import { bookRepo, listFiles, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { parseFile } from "~/lib/novels/frontmatter";
import { titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { currentOrder, firstSentence, withChapterOrder, type ChapterOrder } from "~/lib/writing/binder";
import { statusList } from "~/lib/writing.server";

import type { Route } from "./+types/book.corkboard";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Corkboard · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [files, status] = await Promise.all([listFiles(env.DB, project), statusList(env.DB, project)]);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const order = currentOrder(files.map((f) => f.path));
  const sources = await chapterSources(
    env.DB,
    project.id,
    order.flatMap((c) => c.scenes),
  );
  return {
    project: { slug: project.slug, name: project.name },
    canMove: can(project.role, "edit") && bookRepo(env).repo !== null,
    labels: status.labels,
    chapters: order.map((c) => ({
      slug: c.chapter,
      title: titleFromSegment(c.chapter),
      cards: c.scenes.map((path) => {
        const meta = byPath.get(path)?.meta;
        const header = meta?.kind === "scene" ? meta.header : null;
        const summary = header?.summary ?? "";
        return {
          path,
          title: titleFromSegment(path.split("/")[2]!.replace(/\.md$/, "")),
          summary: summary || firstSentence(parseFile(sources.get(path) ?? "").body),
          fromText: !summary,
          pov: header?.pov ?? "",
          status: header?.status ?? "",
          words: byPath.get(path)?.words ?? 0,
        };
      }),
    })),
  };
}

/** One step up or down, as a list's buttons post it with no script. */
function stepped(ids: string[], form: FormData): string[] {
  const up = form.get("up");
  const down = form.get("down");
  const id = String(up ?? down ?? "");
  const at = ids.indexOf(id);
  if (at < 0) return ids;
  return moveId(ids, id, Math.max(0, Math.min(ids.length - 1, at + (up ? -1 : 1))));
}

export async function action({ params, request, context }: Route.ActionArgs): Promise<{ result: ReorderResult }> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "edit");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const paths = (await listFiles(env.DB, project)).map((f) => f.path);
  const now = currentOrder(paths);

  let desired: ChapterOrder[];
  if (intent === "chapters") {
    const ids = stepped(form.getAll("order").map(String), form);
    const by = new Map(now.map((c) => [c.chapter, c]));
    desired = ids.map((id) => by.get(id) ?? { chapter: id, scenes: [] });
  } else if (intent === "scenes") {
    const chapter = String(form.get("chapter") ?? "");
    desired = withChapterOrder(paths, chapter, stepped(form.getAll("order").map(String), form));
  } else if (intent === "move-to") {
    const path = String(form.get("path") ?? "");
    const target = String(form.get("target") ?? "");
    desired = now.map((c) => ({ chapter: c.chapter, scenes: c.scenes.filter((s) => s !== path) }));
    const into = desired.find((c) => c.chapter === target);
    if (!into || !now.some((c) => c.scenes.includes(path))) throw new Response("Bad request", { status: 400 });
    into.scenes.push(path);
  } else {
    throw new Response("Bad request", { status: 400 });
  }

  const { repo, detail } = bookRepo(env);
  if (!repo) return { result: { ok: false, reason: "failed", message: `${detail} Nothing was moved.` } };
  return { result: await reorderBook(env.DB, repo, project, viewer, desired) };
}

type Card = Route.ComponentProps["loaderData"]["chapters"][number]["cards"][number];

export default function Corkboard({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canMove, labels, chapters } = loaderData;
  const mover = useFetcher<typeof action>();
  const base = `/b/${project.slug}`;
  const result = mover.data?.result ?? actionData?.result ?? null;
  const moving = mover.state !== "idle";
  const send = (fields: Record<string, string | string[]>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
    void mover.submit(body, { method: "post" });
  };

  // A card's "Move to" sits inside the list's form, so its controls belong to a form of their own
  // placed after the list (the form attribute), never a form nested in another.
  const moveForm = (c: Card) => `move-${c.path.replace(/[^a-z0-9]+/g, "-")}`;
  const card = (c: Card, chapter: string) => (
    <div className="app-card">
      <div className="app-card-head">
        <Link to={`${base}/f/${c.path}`} className="app-card-title">
          {c.title}
        </Link>
        <StatusLabelPill labels={labels} status={c.status} />
      </div>
      <p className={c.fromText ? "app-card-summary cap-muted" : "app-card-summary"}>
        {c.summary || "No summary yet."}
        {c.fromText && c.summary ? <span className="cap-sr-only"> (the scene's first sentence; it has no summary)</span> : null}
      </p>
      <p className="app-card-facts cap-muted">
        {c.pov ? <>{c.pov}, </> : null}
        {c.words.toLocaleString("en-US")} words
      </p>
      {canMove && chapters.length > 1 ? (
        <div className="app-card-move">
          <Field label={<span>Move {c.title} to</span>}>
            <Select form={moveForm(c)} name="target" size="sm" required defaultValue="" options={[{ value: "", label: "Another chapter", disabled: true }, ...chapters.filter((x) => x.slug !== chapter).map((x) => ({ value: x.slug, label: x.title }))]} />
          </Field>
          <Button type="submit" form={moveForm(c)} size="sm" pending={moving}>
            Move
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: base }, { label: "Corkboard" }]}
        title="Corkboard"
        lead="Each chapter's scenes as cards, in reading order. Moving a card or a chapter renumbers the files after it, in one commit."
        actions={
          <Link to={`${base}/outliner`} className="cap-btn">
            Outliner
          </Link>
        }
      />

      <p role="status" className="app-note">
        {moving ? "Saving the new order to Git." : result?.ok ? (result.renames.length === 0 ? "Nothing to move." : `Moved. ${result.renames.length} file${result.renames.length === 1 ? "" : "s"} renumbered in one commit.`) : ""}
      </p>
      {result && !result.ok ? <Alert tone="crit">{result.message}</Alert> : null}
      {!canMove ? <Banner tone="info">The order is shown as it stands. Moving needs an Editor or the Owner, and Git connected.</Banner> : null}

      {chapters.length === 0 ? (
        <Empty kind="nothing-yet" title="No scenes yet">
          Start a chapter on the book page, or refresh from Git.
        </Empty>
      ) : (
        <>
          <Panel title="Chapters" count={chapters.length}>
            {canMove ? (
              <Form method="post">
                <input type="hidden" name="intent" value="chapters" />
                <SortableList
                  items={chapters}
                  getId={(c) => c.slug}
                  getLabel={(c) => c.title}
                  name="order"
                  aria-label="Chapters in order"
                  renderItem={(c) => (
                    <>
                      <span className="cap-sortable-label">{c.title}</span>
                      <span className="cap-sortable-detail">
                        {c.cards.length} scene{c.cards.length === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                  onReorder={(order) => send({ intent: "chapters", order })}
                />
              </Form>
            ) : (
              <ol className="app-links">
                {chapters.map((c) => (
                  <li key={c.slug}>{c.title}</li>
                ))}
              </ol>
            )}
          </Panel>

          {chapters.map((chapter) => (
            <Panel key={chapter.slug} title={chapter.title} count={chapter.cards.length} headingId={`cork-${chapter.slug}`}>
              {canMove ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="scenes" />
                  <input type="hidden" name="chapter" value={chapter.slug} />
                  <SortableList items={chapter.cards} getId={(c) => c.path} getLabel={(c) => c.title} name="order" layout="cards" aria-labelledby={`cork-${chapter.slug}`} renderItem={(c) => card(c, chapter.slug)} onReorder={(order) => send({ intent: "scenes", chapter: chapter.slug, order })} />
                </Form>
              ) : null}
              {canMove && chapters.length > 1
                ? chapter.cards.map((c) => (
                    <form
                      key={c.path}
                      id={moveForm(c)}
                      method="post"
                      hidden
                      onSubmit={(e) => {
                        e.preventDefault();
                        send(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
                      }}
                    >
                      <input type="hidden" name="intent" value="move-to" />
                      <input type="hidden" name="path" value={c.path} />
                    </form>
                  ))
                : null}
              {canMove ? null : (
                <ol className="app-cards" aria-labelledby={`cork-${chapter.slug}`}>
                  {chapter.cards.map((c) => (
                    <li key={c.path}>{card(c, chapter.slug)}</li>
                  ))}
                </ol>
              )}
            </Panel>
          ))}
        </>
      )}
    </div>
  );
}
