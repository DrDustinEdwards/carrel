// The book view: its chapters and scenes in reading order with each scene's header, the bible and
// the outline, the flags the checks have open, and export for the Owner. The list is Carrel's index
// of the book's folder in Git; Refresh reads Git again.

import type { ReactNode } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button, ButtonGroup } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Select } from "capsomer/react/select";
import { StatTile, StatTiles } from "capsomer/react/stat-tile";
import { Status } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";

import { bookRepo, draftPaths, exportGate, listFiles, listFindings, refreshBook, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { chapterOf, nextNumbered, readingOrder, slugify, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";

import type { Route } from "./+types/book";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.project.name} · Carrel` : "Carrel" }];
}

const BIBLE_FOLDERS = { character: "characters", place: "places", rule: "rules" } as const;

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const [files, open, drafts] = await Promise.all([
    listFiles(env.DB, project),
    listFindings(env.DB, project, { status: "open" }),
    draftPaths(env.DB, project, viewer),
  ]);
  const flags = new Map<string, number>();
  for (const f of open) flags.set(f.path, (flags.get(f.path) ?? 0) + 1);

  const chapters: { slug: string; title: string; words: number; flags: number; scenes: { path: string; name: string; pov: string; date: string; location: string; words: number; flags: number }[] }[] = [];
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
      pov: header?.pov ?? "",
      date: header?.date ?? "",
      location: header?.location ?? "",
      words: file.words,
      flags: n,
    });
  }

  const bible = files.flatMap(({ path, meta }) =>
    meta.kind === "character" || meta.kind === "place" || meta.kind === "rule"
      ? [{ path, kind: meta.kind, name: meta.entry.name, flags: flags.get(path) ?? 0 }]
      : [],
  );
  const others = files.filter((f) => f.kind === "outline" || f.kind === "note" || f.kind === "book").map((f) => ({ path: f.path, kind: f.kind }));
  const known = new Set(files.map((f) => f.path));
  const connection = bookRepo(env);
  const canPublish = can(project.role, "publish");

  return {
    project: { slug: project.slug, name: project.name, book: project.book },
    canEdit: can(project.role, "edit"),
    canPublish,
    connected: connection.repo !== null,
    connectionDetail: connection.detail,
    chapters,
    bible,
    others,
    hasBookFile: known.has("book.md"),
    words: files.filter((f) => f.kind === "scene").reduce((n, f) => n + f.words, 0),
    open: open.length,
    exportReady: canPublish ? (await exportGate(env.DB, project)).ok : false,
    // Drafts of files Git does not have yet, so a started scene is not lost from view.
    unsaved: drafts.filter((p) => !known.has(p)),
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

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
  const slug = slugify(name);
  if (!slug) return { refreshed: null, error: "Give it a name with at least one letter or digit." };
  const files = await listFiles(env.DB, project);

  if (intent === "new-chapter") {
    const chapters = [...new Set(files.map((f) => chapterOf(f.path)).filter((c): c is string => c !== null))];
    return redirect(`/b/${project.slug}/f/chapters/${nextNumbered(chapters, slug)}/01-${slugify(String(form.get("scene") ?? "")) || "opening"}.md`);
  }
  if (intent === "new-bible") {
    const kind = String(form.get("kind") ?? "") as keyof typeof BIBLE_FOLDERS;
    if (!Object.hasOwn(BIBLE_FOLDERS, kind)) throw new Response("Bad request", { status: 400 });
    return redirect(`/b/${project.slug}/f/bible/${BIBLE_FOLDERS[kind]}/${slug}.md?name=${encodeURIComponent(name)}`);
  }
  if (intent === "new-outline") return redirect(`/b/${project.slug}/f/outline/${slug}.md`);
  throw new Response("Bad request", { status: 400 });
}

export default function Book({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canEdit, canPublish, connected, connectionDetail, chapters, bible, others, words, open, exportReady, unsaved, hasBookFile } = loaderData;
  const navigation = useNavigation();
  const refreshing = navigation.state !== "idle" && navigation.formData?.get("intent") === "refresh";
  const base = `/b/${project.slug}`;
  const file = (path: string) => `${base}/f/${path}`;
  const link = ({ href, children }: { href: string; children: ReactNode }) => <Link to={href}>{children}</Link>;

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={
          <>
            <span className="cap-mono">{project.book}/</span> in the novels repository.
          </>
        }
        actions={
          <>
            {connected ? (
              <Form method="post">
                <Button type="submit" name="intent" value="refresh" pending={refreshing}>
                  {refreshing ? "Refreshing" : "Refresh from Git"}
                </Button>
              </Form>
            ) : null}
            <Link to={`${base}/authorship`} className="cap-btn" reloadDocument>
              Authorship record
            </Link>
            {canPublish ? (
              exportReady ? (
                <ButtonGroup label="Export">
                  <a className="cap-btn" href={`${base}/export/epub`}>
                    ePub
                  </a>
                  <a className="cap-btn" href={`${base}/export/docx`}>
                    Word
                  </a>
                  <a className="cap-btn" href={`${base}/export/print`} target="_blank" rel="noreferrer">
                    Print or PDF<span className="cap-sr-only"> (opens in a new tab)</span>
                  </a>
                </ButtonGroup>
              ) : (
                <Button disabledReason="Export waits until every flag is fixed or dismissed.">Export</Button>
              )
            ) : null}
          </>
        }
      />

      <StatTiles label="The book at a glance">
        <StatTile label="Words in scenes" figure={words.toLocaleString()} detail={`${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`} />
        {open === 0 ? (
          <StatTile label="Open flags" tone="ok" word="Clear" figure="0" detail="Nothing holds export." />
        ) : (
          <StatTile label="Open flags" tone="warn" word="Open" figure={open} detail="They hold export until fixed or dismissed." />
        )}
      </StatTiles>

      {!connected ? (
        <Banner tone="warn" title="Git is not connected yet">
          {connectionDetail} The book shows Carrel's last index of it, and saving waits for the connection.
        </Banner>
      ) : null}

      {actionData?.error ? (
        <Alert tone="crit">{actionData.error}</Alert>
      ) : actionData?.refreshed ? (
        <Banner tone="ok">
          {actionData.refreshed.files} files in Git, {actionData.refreshed.read} read again, {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more on the next refresh" : ""}.
        </Banner>
      ) : null}

      {unsaved.length > 0 ? (
        <Panel title="Your drafts not yet in Git" count={unsaved.length} flush>
          <RowList label="Your drafts not yet in Git">
            {unsaved.map((p) => (
              <Row key={p} title={<span className="cap-mono">{p}</span>} href={file(p)} renderLink={link} detail="Started here; nothing is in Git until the first Save." />
            ))}
          </RowList>
        </Panel>
      ) : null}

      <div className="app-split" data-aside>
        <Panel
          title="Chapters"
          count={chapters.length}
          flush
          footer={
            canEdit ? (
              <Form method="post" className="app-inline-form">
                <input type="hidden" name="intent" value="new-chapter" />
                <Field label="New chapter">
                  <input className="cap-input" name="name" required placeholder="Chapter name" autoComplete="off" />
                </Field>
                <Field label="First scene">
                  <input className="cap-input" name="scene" placeholder="Scene name" autoComplete="off" />
                </Field>
                <Button type="submit">Start it</Button>
              </Form>
            ) : undefined
          }
        >
          {chapters.length === 0 ? (
            <Empty kind="nothing-yet" flush title="No chapters in the index yet">
              {canEdit ? "Start the first chapter below, or refresh from Git." : "Refresh from Git to read the book's folder."}
            </Empty>
          ) : (
            chapters.map((chapter) => (
              <section key={chapter.slug} className="app-chapter" aria-labelledby={`chapter-${chapter.slug}`}>
                <h3 id={`chapter-${chapter.slug}`}>
                  <Link to={`${base}/c/${chapter.slug}`}>{chapter.title}</Link>
                  <span className="cap-muted">{chapter.words.toLocaleString()} words</span>
                  {chapter.flags ? <Status tone="warn">{chapter.flags} flagged</Status> : null}
                </h3>
                <div className="cap-table-wrap" role="region" aria-labelledby={`scenes-${chapter.slug}`} tabIndex={0}>
                  <table className="cap-table">
                    <caption id={`scenes-${chapter.slug}`} className="cap-sr-only">
                      Scenes in {chapter.title}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Scene</th>
                        <th scope="col">Point of view</th>
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
                          <td>{s.pov}</td>
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

        <div className="app-stack">
          <Panel
            title="Bible"
            count={bible.length}
            footer={
              canEdit ? (
                <Form method="post" className="app-inline-form">
                  <input type="hidden" name="intent" value="new-bible" />
                  <Field label="New entry">
                    <Select
                      name="kind"
                      defaultValue="character"
                      options={[
                        { value: "character", label: "Character" },
                        { value: "place", label: "Place" },
                        { value: "rule", label: "World rule" },
                      ]}
                    />
                  </Field>
                  <Field label="Name">
                    <input className="cap-input" name="name" required placeholder="Name" autoComplete="off" />
                  </Field>
                  <Button type="submit">Start it</Button>
                </Form>
              ) : undefined
            }
          >
            {(["character", "place", "rule"] as const).map((kind) => {
              const entries = bible.filter((b) => b.kind === kind);
              const heading = kind === "character" ? "Characters" : kind === "place" ? "Places" : "World rules";
              return (
                <section key={kind} className="app-section" aria-labelledby={`bible-${kind}`}>
                  <h3 id={`bible-${kind}`}>{heading}</h3>
                  {entries.length === 0 ? (
                    <p className="cap-muted">None yet.</p>
                  ) : (
                    <ul className="app-links">
                      {entries.map((b) => (
                        <li key={b.path}>
                          <Link to={file(b.path)}>{b.name}</Link>
                          {b.flags ? <Status tone="warn">{b.flags} flagged</Status> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </Panel>

          <Panel
            title="Outline and notes"
            footer={
              canEdit ? (
                <Form method="post" className="app-inline-form">
                  <input type="hidden" name="intent" value="new-outline" />
                  <Field label="New outline file">
                    <input className="cap-input" name="name" required placeholder="Name" autoComplete="off" />
                  </Field>
                  <Button type="submit">Start it</Button>
                </Form>
              ) : undefined
            }
          >
            {others.length === 0 && (hasBookFile || !canEdit) ? (
              <p className="cap-muted">None yet.</p>
            ) : (
              <ul className="app-links">
                {others.map((o) => (
                  <li key={o.path}>
                    <Link to={file(o.path)}>{o.kind === "book" ? "Title page (book.md)" : o.path}</Link>
                  </li>
                ))}
                {!hasBookFile && canEdit ? (
                  <li>
                    <Link to={file("book.md")}>Add a title page (book.md)</Link>
                  </li>
                ) : null}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
