// The corkboard (design 4.2), a view of a book's Manuscript tab: the book's chapters in order, then
// each chapter's scenes as compact cards with the summary, point of view, status and words. Chapters
// and cards move by dragging a grip, by the keyboard, or by Move up and Move down; a card's menu also
// moves it to another chapter. Every move is renames of numbered files in one commit
// (lib/binder.server.ts). It works with no script: the lists sit in forms whose buttons post the move,
// and the card menu is a native disclosure of submit buttons (Capsomer's form menu look).

import { useEffect, useRef } from "react";
import { Form, useFetcher } from "react-router";
import { enhance } from "capsomer/behavior/menu";
import { Alert, Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { SortableList, moveId } from "capsomer/react/sortable-list";
import { Link } from "capsomer/react/link";

import { BookHead } from "~/components/book-head";
import { StatusLabelPill } from "~/components/writing/status-label";

import { reorderBook, chapterSources, type ReorderResult } from "~/lib/binder.server";
import { bookHead, bookRepo, listFiles, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { parseFile } from "~/lib/novels/frontmatter";
import { titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import {
  currentOrder,
  firstSentence,
  withChapterOrder,
  type ChapterOrder,
} from "~/lib/writing/binder";
import { statusList } from "~/lib/writing.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.corkboard";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Corkboard · ${data.head.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [files, status, head] = await Promise.all([
    listFiles(env.DB, project),
    statusList(env.DB, project),
    bookHead(env, project),
  ]);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const order = currentOrder(files.map((f) => f.path));
  const sources = await chapterSources(
    env.DB,
    project.id,
    order.flatMap((c) => c.scenes),
  );
  return {
    head,
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

export async function action({
  params,
  request,
  context,
}: Route.ActionArgs): Promise<{ result: ReorderResult }> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "edit");
  const form = await readForm(request);
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
    if (!into || !now.some((c) => c.scenes.includes(path)))
      throw new Response("Bad request", { status: 400 });
    into.scenes.push(path);
  } else {
    throw new Response("Bad request", { status: 400 });
  }

  const { repo, detail } = bookRepo(env);
  if (!repo)
    return { result: { ok: false, reason: "failed", message: `${detail} Nothing was moved.` } };
  return { result: await reorderBook(env.DB, repo, project, viewer, desired) };
}

type Card = Route.ComponentProps["loaderData"]["chapters"][number]["cards"][number];

/** A card's menu: Move to each other chapter. Its buttons submit the card's own form (the form
 * attribute), since the card sits inside its chapter's list form and forms do not nest. */
function CardMenu({
  title,
  form,
  chapters,
}: {
  title: string;
  form: string;
  chapters: { slug: string; title: string }[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => (ref.current?.parentNode ? enhance(ref.current.parentNode) : undefined), []);
  return (
    <details className="cap-menu-form app-card-menu" data-cap="menu-form" ref={ref}>
      <summary className="cap-btn cap-menu-trigger" data-size="sm">
        Move to<span className="cap-sr-only"> another chapter: {title}</span>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>
      <div className="cap-popover cap-menu">
        {chapters.map((c) => (
          <button
            key={c.slug}
            type="submit"
            form={form}
            name="target"
            value={c.slug}
            className="cap-option cap-menu-item"
            onClick={() => {
              if (ref.current) ref.current.open = false;
            }}
          >
            <span className="cap-option-label">{c.title}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

export default function Corkboard({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canMove, labels, chapters } = loaderData;
  const mover = useFetcher<typeof action>();
  const base = `/b/${head.slug}`;
  const result = mover.data?.result ?? actionData?.result ?? null;
  const moving = mover.state !== "idle";
  const send = (fields: Record<string, string | string[]>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
    void mover.submit(body, { method: "post" });
  };

  // A card's "Move to" sits inside the list's form, so its buttons belong to a form of their own
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
        {c.fromText && c.summary ? (
          <span className="cap-sr-only"> (the scene's first sentence; it has no summary)</span>
        ) : null}
      </p>
      <div className="app-card-foot">
        <p className="app-card-facts cap-muted">
          {c.pov ? <>{c.pov}, </> : null}
          {c.words.toLocaleString("en-US")} words
        </p>
        {canMove && chapters.length > 1 ? (
          <CardMenu
            title={c.title}
            form={moveForm(c)}
            chapters={chapters.filter((x) => x.slug !== chapter)}
          />
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="app-page">
      <BookHead book={head} section="manuscript" view="corkboard" />
      <div className="app-stack" data-tight>
        <p className="cap-muted app-note">
          Each chapter's scenes as cards, in reading order. Moving a card or a chapter renumbers the
          files after it, in one commit.
        </p>

        <p role="status" className="app-note">
          {moving
            ? "Saving the new order to Git."
            : result?.ok
              ? result.renames.length === 0
                ? "Nothing to move."
                : `Moved. ${result.renames.length} file${result.renames.length === 1 ? "" : "s"} renumbered in one commit.`
              : ""}
        </p>
      </div>
      {result && !result.ok ? <Alert tone="crit">{result.message}</Alert> : null}
      {!canMove ? (
        <Banner tone="info">
          The order is shown as it stands. Moving needs an Editor or the Owner, and Git connected.
        </Banner>
      ) : null}

      {chapters.length === 0 ? (
        <Empty kind="nothing-yet" title="No scenes yet">
          Start a chapter in the List view, or refresh from Git.
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
            <Panel
              key={chapter.slug}
              className="app-panel-menus"
              title={chapter.title}
              count={chapter.cards.length}
              headingId={`cork-${chapter.slug}`}
            >
              {canMove ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="scenes" />
                  <input type="hidden" name="chapter" value={chapter.slug} />
                  <SortableList
                    items={chapter.cards}
                    getId={(c) => c.path}
                    getLabel={(c) => c.title}
                    name="order"
                    layout="cards"
                    aria-labelledby={`cork-${chapter.slug}`}
                    renderItem={(c) => card(c, chapter.slug)}
                    onReorder={(order) => send({ intent: "scenes", chapter: chapter.slug, order })}
                  />
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
                        // The chosen chapter is the pressed button's value, so the submitter goes in.
                        const submitter = (e.nativeEvent as SubmitEvent).submitter;
                        send(
                          Object.fromEntries(new FormData(e.currentTarget, submitter)) as Record<
                            string,
                            string
                          >,
                        );
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
