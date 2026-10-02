// One chapter: its scenes in order with their headers and Dustin's beats, and the chapter's text read
// straight through, as the index last had it from Git.

import type { ReactNode } from "react";
import { Form, Link, redirect } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Status } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";

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
  const link = ({ href, children }: { href: string; children: ReactNode }) => <Link to={href}>{children}</Link>;
  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: base }, { label: chapter.title }]}
        title={chapter.title}
        lead={`${scenes.length} scene${scenes.length === 1 ? "" : "s"}, ${scenes.reduce((n, s) => n + s.words, 0).toLocaleString()} words.`}
      />

      {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}

      <div className="app-split" data-aside data-flip>
        <Panel
          title="Scenes"
          count={scenes.length}
          flush
          footer={
            canEdit ? (
              <Form method="post" className="app-inline-form">
                <Field label="New scene">
                  <input className="cap-input" name="name" required placeholder="Scene name" autoComplete="off" />
                </Field>
                <Button type="submit">Start it</Button>
              </Form>
            ) : undefined
          }
        >
          <RowList label="Scenes">
            {scenes.map((s) => (
              <Row
                key={s.path}
                title={s.name}
                href={`${base}/f/${s.path}`}
                renderLink={link}
                status={s.flags ? <Status tone="warn">{s.flags} flagged</Status> : undefined}
                detail={
                  s.header ? (
                    <dl className="app-scene-header">
                      <div>
                        <dt>Point of view</dt>
                        <dd>{s.header.pov || "(none)"}</dd>
                      </div>
                      <div>
                        <dt>Date</dt>
                        <dd>
                          {s.header.date || "(none)"}
                          {s.header.flashback ? " (flashback)" : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>Location</dt>
                        <dd>{s.header.location || "(none)"}</dd>
                      </div>
                      <div>
                        <dt>Present</dt>
                        <dd>{s.header.characters.join(", ") || "(none)"}</dd>
                      </div>
                      <div>
                        <dt>Goal</dt>
                        <dd>{s.header.goal || "(none)"}</dd>
                      </div>
                      <div>
                        <dt>Conflict</dt>
                        <dd>{s.header.conflict || "(none)"}</dd>
                      </div>
                      <div>
                        <dt>Outcome</dt>
                        <dd>{s.header.outcome || "(none)"}</dd>
                      </div>
                    </dl>
                  ) : undefined
                }
                meta={<span className="cap-num">{s.words.toLocaleString()} words</span>}
              />
            ))}
          </RowList>
        </Panel>

        <Panel title="The chapter, read through" headingId="text-heading">
          <div data-context="prose" className="app-reading">
            {scenes.map((s, i) => (
              <div key={s.path}>
                {i > 0 ? (
                  <p className="app-scene-break" aria-hidden="true">
                    * * *
                  </p>
                ) : null}
                <div dangerouslySetInnerHTML={{ __html: s.html }} />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
