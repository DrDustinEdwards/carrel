// A book's Manuscript tab, List view: its chapters and scenes in reading order with each scene's
// header and the flags the checks have open. The list is Carrel's index of the book's folder in Git;
// Refresh (in the head of every tab) posts here and reads Git again. Progress, the bible and notes and
// the settings are tabs of their own (book.progress.tsx, book.bible.tsx, book.settings.tsx).

import type { ReactNode } from "react";
import { Form, redirect } from "react-router";
import { Link } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";
import { ColorLabelPill } from "capsomer/react/label-color-list";
import { InlineAddForm } from "capsomer/react/inline-add-form";

import { BookHead } from "~/components/book-head";

import {
  bookHead,
  bookRepo,
  draftPaths,
  listFiles,
  listFindings,
  refreshBook,
  requireBookProject,
} from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { slugify } from "@drdustinedwards/site-helpers/slug";
import { chapterOf, nextNumbered, readingOrder, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { reorderBook } from "~/lib/binder.server";
import { parseOrder } from "~/lib/writing/binder";
import { statusList } from "~/lib/writing.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.head.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const [files, open, drafts, status, head] = await Promise.all([
    listFiles(env.DB, project),
    listFindings(env.DB, project, { status: "open" }),
    draftPaths(env.DB, project, viewer),
    statusList(env.DB, project),
    bookHead(env, project),
  ]);
  const flags = new Map<string, number>();
  for (const f of open) flags.set(f.path, (flags.get(f.path) ?? 0) + 1);

  const chapters: {
    slug: string;
    title: string;
    words: number;
    flags: number;
    scenes: {
      path: string;
      name: string;
      status: string;
      pov: string;
      date: string;
      location: string;
      words: number;
      flags: number;
    }[];
  }[] = [];
  for (const file of readingOrder(files)) {
    const slug = chapterOf(file.path)!;
    let chapter = chapters.at(-1);
    if (!chapter || chapter.slug !== slug) {
      chapter = { slug, title: titleFromSegment(slug), words: 0, flags: 0, scenes: [] };
      chapters.push(chapter);
    }
    const header = file.meta.kind === "scene" ? file.meta.header : null;
    const n = flags.get(file.path) ?? 0;
    chapter.words += file.words;
    chapter.flags += n;
    chapter.scenes.push({
      path: file.path,
      name: titleFromSegment(file.path.split("/")[2]!.replace(/\.md$/, "")),
      // An index row from before the status key reads as no status until its next save or refresh.
      status: header?.status ?? "",
      pov: header?.pov ?? "",
      date: header?.date ?? "",
      location: header?.location ?? "",
      words: file.words,
      flags: n,
    });
  }

  const known = new Set(files.map((f) => f.path));
  const connection = bookRepo(env);

  return {
    head,
    canEdit: can(project.role, "edit"),
    connectionDetail: connection.detail,
    chapters,
    words: files.filter((f) => f.kind === "scene").reduce((n, f) => n + f.words, 0),
    open: open.length,
    // Drafts of files Git does not have yet, so a started scene is not lost from view.
    unsaved: drafts.filter((p) => !known.has(p)),
    labels: status.labels,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");

  // A move in the binder: the whole new order, which the server turns into one commit of renames.
  if (intent === "reorder") {
    const order = parseOrder(String(form.get("order") ?? ""));
    if (!order) throw new Response("Bad request", { status: 400 });
    const { repo, detail } = bookRepo(env);
    if (!repo)
      return {
        refreshed: null,
        error: null,
        reorder: {
          ok: false as const,
          reason: "failed" as const,
          message: `${detail} Nothing was moved.`,
        },
      };
    return {
      refreshed: null,
      error: null,
      reorder: await reorderBook(env.DB, repo, project, getViewer(context), order),
    };
  }

  if (intent === "refresh") {
    const { repo, detail } = bookRepo(env);
    if (!repo) return { refreshed: null, error: detail };
    try {
      return { refreshed: await refreshBook(env.DB, repo, project), error: null };
    } catch (error) {
      return { refreshed: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Starting a file only opens the editor on it; nothing reaches Git until the first Save.
  if (!can(project.role, "edit")) throw new Response("Forbidden", { status: 403 });
  const name = String(form.get("name") ?? "").trim();
  const slug = slugify(name, { max: 60 });
  if (!slug) return { refreshed: null, error: "Give it a name with at least one letter or digit." };
  const files = await listFiles(env.DB, project);

  if (intent === "new-chapter") {
    const chapters = [
      ...new Set(files.map((f) => chapterOf(f.path)).filter((c): c is string => c !== null)),
    ];
    return redirect(
      `/b/${project.slug}/f/chapters/${nextNumbered(chapters, slug)}/01-${slugify(String(form.get("scene") ?? ""), { max: 60 }) || "opening"}.md`,
    );
  }
  throw new Response("Bad request", { status: 400 });
}

export default function Book({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canEdit, connectionDetail, chapters, words, open, unsaved, labels } = loaderData;
  const base = `/b/${head.slug}`;
  const file = (path: string) => `${base}/f/${path}`;
  const link = ({ href, children }: { href: string; children: ReactNode }) => (
    <Link to={href}>{children}</Link>
  );

  return (
    <div className="app-page">
      <BookHead book={head} section="manuscript" view="list" />

      <StatTiles label="The book at a glance">
        <StatTile
          label="Words in scenes"
          figure={words.toLocaleString()}
          detail={`${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`}
        />
        {open === 0 ? (
          <StatTile
            label="Open flags"
            tone="ok"
            word="Clear"
            figure="0"
            detail="Nothing holds export."
          />
        ) : (
          <StatTile
            label="Open flags"
            tone="warn"
            word="Open"
            figure={open}
            detail="They hold export until fixed or dismissed."
          />
        )}
      </StatTiles>

      {!head.connected ? (
        <Banner tone="warn" title="Git is not connected yet">
          {connectionDetail} The book shows Carrel's last index of it, and saving waits for the
          connection.
        </Banner>
      ) : null}

      {actionData?.error ? (
        <Alert tone="crit">{actionData.error}</Alert>
      ) : actionData?.refreshed ? (
        <Banner tone="ok">
          {actionData.refreshed.files} files in Git, {actionData.refreshed.read} read again,{" "}
          {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more on the next refresh" : ""}.
        </Banner>
      ) : null}

      {unsaved.length > 0 ? (
        <Panel title="Your drafts not yet in Git" count={unsaved.length} flush>
          <RowList label="Your drafts not yet in Git">
            {unsaved.map((p) => (
              <Row
                key={p}
                title={<span className="cap-mono">{p}</span>}
                href={file(p)}
                renderLink={link}
                detail="Started here; nothing is in Git until the first Save."
              />
            ))}
          </RowList>
        </Panel>
      ) : null}

      <Panel
        title="Chapters"
        count={chapters.length}
        flush
        footer={
          canEdit ? (
            <InlineAddForm Form={Form} hidden={{ intent: "new-chapter" }} submit="Start it">
              <Field label="New chapter">
                <input
                  className="cap-input"
                  name="name"
                  required
                  placeholder="Chapter name"
                  autoComplete="off"
                />
              </Field>
              <Field label="First scene">
                <input
                  className="cap-input"
                  name="scene"
                  placeholder="Scene name"
                  autoComplete="off"
                />
              </Field>
            </InlineAddForm>
          ) : undefined
        }
      >
        {chapters.length === 0 ? (
          <Empty kind="nothing-yet" flush title="No chapters in the index yet">
            {canEdit
              ? "Start the first chapter below, or refresh from Git."
              : "Refresh from Git to read the book's folder."}
          </Empty>
        ) : (
          chapters.map((chapter) => (
            <section
              key={chapter.slug}
              className="app-chapter"
              aria-labelledby={`chapter-${chapter.slug}`}
            >
              <h3 id={`chapter-${chapter.slug}`}>
                <Link to={`${base}/c/${chapter.slug}`}>{chapter.title}</Link>
                <span className="cap-muted">{chapter.words.toLocaleString()} words</span>
                {chapter.flags ? <Status tone="warn">{chapter.flags} flagged</Status> : null}
              </h3>
              <div
                className="cap-table-wrap"
                role="region"
                aria-labelledby={`scenes-${chapter.slug}`}
                tabIndex={0}
              >
                <table className="cap-table">
                  <caption id={`scenes-${chapter.slug}`} className="cap-sr-only">
                    Scenes in {chapter.title}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Scene</th>
                      <th scope="col">Status</th>
                      <th scope="col" data-drop="1">
                        Point of view
                      </th>
                      <th scope="col" data-drop="1">
                        Date
                      </th>
                      <th scope="col" data-drop="2">
                        Location
                      </th>
                      <th scope="col" data-num>
                        Words
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {chapter.scenes.map((s) => (
                      <tr key={s.path}>
                        <th scope="row">
                          <Link className="cap-table-open" to={file(s.path)}>
                            {s.name}
                          </Link>
                          {s.flags ? <Status tone="warn">{s.flags} flagged</Status> : null}
                        </th>
                        <td>
                          <ColorLabelPill
                            labels={labels}
                            value={s.status}
                            unknownNote=" (not on the status list)"
                          />
                        </td>
                        <td data-drop="1">{s.pov}</td>
                        <td data-drop="1">{s.date}</td>
                        <td data-drop="2">{s.location}</td>
                        <td data-num>{s.words.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </Panel>
    </div>
  );
}
