// One chapter: its scenes in order with their headers and Dustin's beats, and the chapter's text read
// straight through, as the index last had it from Git.

import { Form, Link, redirect } from "react-router";

import { indexedFile, listFiles, listFindings, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { blocksToHtml, parseProse } from "~/lib/novels/export";
import { parseFile } from "~/lib/novels/frontmatter";
import { chapterOf, nextNumbered, readingOrder, slugify, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";

import type { Route } from "./+types/book.chapter";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.chapter.title} · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const files = readingOrder(await listFiles(env.DB, project)).filter((f) => chapterOf(f.path) === params.chapter);
  if (files.length === 0) throw new Response("Not found", { status: 404 });
  const open = await listFindings(env.DB, project, { status: "open" });

  const scenes = await Promise.all(
    files.map(async (f) => {
      const source = (await indexedFile(env.DB, project, f.path))?.source ?? "";
      const header = f.meta.kind === "scene" ? f.meta.header : null;
      return {
        path: f.path,
        name: titleFromSegment(f.path.split("/")[2]!.replace(/\.md$/, "")),
        header,
        words: f.words,
        flags: open.filter((o) => o.path === f.path).length,
        // Escaped by blocksToHtml: scene text is never trusted as markup.
        html: blocksToHtml(parseProse(parseFile(source).body)),
      };
    }),
  );
  return {
    project: { slug: project.slug, name: project.name },
    chapter: { slug: params.chapter, title: titleFromSegment(params.chapter) },
    canEdit: can(project.role, "edit"),
    scenes,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "edit");
  const slug = slugify(String((await request.formData()).get("name") ?? ""));
  if (!slug) return { error: "Give the scene a name with at least one letter or digit." };
  const scenes = (await listFiles(env.DB, project))
    .filter((f) => chapterOf(f.path) === params.chapter)
    .map((f) => f.path.split("/")[2]!.replace(/\.md$/, ""));
  return redirect(`/b/${project.slug}/f/chapters/${params.chapter}/${nextNumbered(scenes, slug)}.md`);
}

export default function Chapter({ loaderData, actionData }: Route.ComponentProps) {
  const { project, chapter, canEdit, scenes } = loaderData;
  const base = `/b/${project.slug}`;
  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={base}>{project.name}</Link>
        </p>
        <h1>{chapter.title}</h1>
      </header>

      <section aria-labelledby="scenes-heading">
        <h2 id="scenes-heading">Scenes</h2>
        <ol className="scene-list">
          {scenes.map((s) => (
            <li key={s.path}>
              <p>
                <Link to={`${base}/f/${s.path}`}>{s.name}</Link> <span className="muted">{s.words.toLocaleString()} words</span>
                {s.flags ? <span className="flag-count"> {s.flags} flagged</span> : null}
              </p>
              {s.header ? (
                <dl className="scene-header">
                  <dt>Point of view</dt>
                  <dd>{s.header.pov || "(none)"}</dd>
                  <dt>Date</dt>
                  <dd>
                    {s.header.date || "(none)"}
                    {s.header.flashback ? " (flashback)" : ""}
                  </dd>
                  <dt>Location</dt>
                  <dd>{s.header.location || "(none)"}</dd>
                  <dt>Present</dt>
                  <dd>{s.header.characters.join(", ") || "(none)"}</dd>
                  <dt>Goal</dt>
                  <dd>{s.header.goal || "(none)"}</dd>
                  <dt>Conflict</dt>
                  <dd>{s.header.conflict || "(none)"}</dd>
                  <dt>Outcome</dt>
                  <dd>{s.header.outcome || "(none)"}</dd>
                </dl>
              ) : null}
            </li>
          ))}
        </ol>
        {canEdit ? (
          <Form method="post" className="inline-form">
            <label className="field-inline">
              <span>New scene</span>
              <input name="name" required placeholder="Scene name" />
            </label>
            <button type="submit" className="btn-ghost">
              Start it
            </button>
          </Form>
        ) : null}
        {actionData?.error ? (
          <p className="alarm" role="alert">
            {actionData.error}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="text-heading" className="chapter-text">
        <h2 id="text-heading">The chapter, read through</h2>
        {scenes.map((s, i) => (
          <div key={s.path}>
            {i > 0 ? <p className="scene-break">* * *</p> : null}
            <div dangerouslySetInnerHTML={{ __html: s.html }} />
          </div>
        ))}
      </section>
    </main>
  );
}
