// The book view: its chapters and scenes in reading order with each scene's header, the bible and
// the outline, the flags the checks have open, and export for the Owner. The list is Carrel's index
// of the book's folder in Git; Refresh reads Git again.

import { Form, Link, redirect, useNavigation } from "react-router";

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

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>{project.name}</h1>
        <p className="muted">
          {project.book}/ in the novels repository · {words.toLocaleString()} words in scenes ·{" "}
          {open === 0 ? "no open flags" : `${open} open flag${open === 1 ? "" : "s"}`}
        </p>
      </header>

      {!connected ? (
        <p className="notice" role="status">
          Git is not connected yet: {connectionDetail} The book shows Carrel's last index of it, and saving waits for the connection.
        </p>
      ) : null}

      <div className="toolbar-row">
        <div className="actions">
          {connected ? (
            <Form method="post">
              <button type="submit" name="intent" value="refresh" className="btn-ghost" disabled={refreshing}>
                {refreshing ? "Refreshing" : "Refresh from Git"}
              </button>
            </Form>
          ) : null}
          <Link to={`${base}/authorship`} className="btn-ghost" reloadDocument>
            Authorship record
          </Link>
        </div>
        {canPublish ? (
          <div className="actions" aria-label="Export">
            {exportReady ? (
              <>
                <a className="btn-ghost" href={`${base}/export/epub`}>
                  ePub
                </a>
                <a className="btn-ghost" href={`${base}/export/docx`}>
                  Word
                </a>
                <a className="btn-ghost" href={`${base}/export/print`} target="_blank" rel="noreferrer">
                  Print or PDF
                </a>
              </>
            ) : (
              <span className="muted">Export waits until every flag is fixed or dismissed.</span>
            )}
          </div>
        ) : null}
      </div>

      {actionData?.error ? (
        <p className="alarm" role="alert">
          {actionData.error}
        </p>
      ) : actionData?.refreshed ? (
        <p className="muted" role="status">
          {actionData.refreshed.files} files in Git, {actionData.refreshed.read} read again, {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more on the next refresh" : ""}.
        </p>
      ) : null}

      {unsaved.length > 0 ? (
        <section aria-labelledby="unsaved-heading">
          <h2 id="unsaved-heading">Your drafts not yet in Git</h2>
          <ul className="project-list">
            {unsaved.map((p) => (
              <li key={p}>
                <Link to={file(p)}>{p}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="chapters-heading">
        <h2 id="chapters-heading">Chapters</h2>
        {chapters.length === 0 ? <p className="muted">No chapters in the index yet.</p> : null}
        {chapters.map((chapter) => (
          <div key={chapter.slug} className="chapter-block">
            <h3>
              <Link to={`${base}/c/${chapter.slug}`}>{chapter.title}</Link>{" "}
              <span className="muted">
                {chapter.words.toLocaleString()} words{chapter.flags ? ` · ${chapter.flags} flagged` : ""}
              </span>
            </h3>
            <table className="items">
              <caption className="sr-only">Scenes in {chapter.title}</caption>
              <thead>
                <tr>
                  <th scope="col">Scene</th>
                  <th scope="col">Point of view</th>
                  <th scope="col">Date</th>
                  <th scope="col">Location</th>
                  <th scope="col">Words</th>
                </tr>
              </thead>
              <tbody>
                {chapter.scenes.map((s) => (
                  <tr key={s.path}>
                    <td>
                      <Link to={file(s.path)}>{s.name}</Link>
                      {s.flags ? <span className="flag-count"> {s.flags} flagged</span> : null}
                    </td>
                    <td>{s.pov}</td>
                    <td>{s.date}</td>
                    <td>{s.location}</td>
                    <td className="muted">{s.words.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {canEdit ? (
          <Form method="post" className="inline-form">
            <input type="hidden" name="intent" value="new-chapter" />
            <label className="field-inline">
              <span>New chapter</span>
              <input name="name" required placeholder="Chapter name" />
            </label>
            <label className="field-inline">
              <span>First scene</span>
              <input name="scene" placeholder="Scene name" />
            </label>
            <button type="submit" className="btn-ghost">
              Start it
            </button>
          </Form>
        ) : null}
      </section>

      <section aria-labelledby="bible-heading">
        <h2 id="bible-heading">Bible</h2>
        {(["character", "place", "rule"] as const).map((kind) => {
          const entries = bible.filter((b) => b.kind === kind);
          return (
            <div key={kind}>
              <h3>{kind === "character" ? "Characters" : kind === "place" ? "Places" : "World rules"}</h3>
              {entries.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="bible-list">
                  {entries.map((b) => (
                    <li key={b.path}>
                      <Link to={file(b.path)}>{b.name}</Link>
                      {b.flags ? <span className="flag-count"> {b.flags} flagged</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {canEdit ? (
          <Form method="post" className="inline-form">
            <input type="hidden" name="intent" value="new-bible" />
            <label className="field-inline">
              <span>New entry</span>
              <select name="kind" defaultValue="character">
                <option value="character">Character</option>
                <option value="place">Place</option>
                <option value="rule">World rule</option>
              </select>
            </label>
            <label className="field-inline">
              <span className="sr-only">Name</span>
              <input name="name" required placeholder="Name" />
            </label>
            <button type="submit" className="btn-ghost">
              Start it
            </button>
          </Form>
        ) : null}
      </section>

      <section aria-labelledby="other-heading">
        <h2 id="other-heading">Outline and notes</h2>
        <ul className="bible-list">
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
        {canEdit ? (
          <Form method="post" className="inline-form">
            <input type="hidden" name="intent" value="new-outline" />
            <label className="field-inline">
              <span>New outline file</span>
              <input name="name" required placeholder="Name" />
            </label>
            <button type="submit" className="btn-ghost">
              Start it
            </button>
          </Form>
        ) : null}
      </section>
    </main>
  );
}
