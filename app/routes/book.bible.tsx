// A book's Bible and notes tab: the characters, places and world rules the checks read, then the
// outline files, notes and the title page. Starting an entry only opens the editor on it; nothing
// reaches Git until the first Save.

import { Form, redirect } from "react-router";
import { Link } from "capsomer/react/link";
import { Alert } from "capsomer/react/banner";
import { InlineAddForm } from "capsomer/react/inline-add-form";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Status } from "capsomer/react/status";

import { BookHead } from "~/components/book-head";

import { bookHead, listFiles, listFindings, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { slugify } from "@drdustinedwards/site-helpers/slug";
import { can } from "~/lib/roles";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.bible";
import "capsomer/inline-add-form.css";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Bible and notes · ${data.head.name} · Carrel` : "Carrel" }];
}

const BIBLE_FOLDERS = { character: "characters", place: "places", rule: "rules" } as const;
const KINDS = [
  { kind: "character", heading: "Characters" },
  { kind: "place", heading: "Places" },
  { kind: "rule", heading: "World rules" },
] as const;

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [files, open, head] = await Promise.all([
    listFiles(env.DB, project),
    listFindings(env.DB, project, { status: "open" }),
    bookHead(env, project),
  ]);
  const flags = new Map<string, number>();
  for (const f of open) flags.set(f.path, (flags.get(f.path) ?? 0) + 1);
  return {
    head,
    canEdit: can(project.role, "edit"),
    bible: files.flatMap(({ path, meta }) =>
      meta.kind === "character" || meta.kind === "place" || meta.kind === "rule"
        ? [{ path, kind: meta.kind, name: meta.entry.name, flags: flags.get(path) ?? 0 }]
        : [],
    ),
    others: files
      .filter((f) => f.kind === "outline" || f.kind === "note" || f.kind === "book")
      .map((f) => ({ path: f.path, kind: f.kind })),
    hasBookFile: files.some((f) => f.path === "book.md"),
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "edit");
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const name = String(form.get("name") ?? "").trim();
  const slug = slugify(name, { max: 60 });
  if (!slug) return { error: "Give it a name with at least one letter or digit." };
  if (intent === "new-bible") {
    const kind = String(form.get("kind") ?? "") as keyof typeof BIBLE_FOLDERS;
    if (!Object.hasOwn(BIBLE_FOLDERS, kind)) throw new Response("Bad request", { status: 400 });
    return redirect(
      `/b/${project.slug}/f/bible/${BIBLE_FOLDERS[kind]}/${slug}.md?name=${encodeURIComponent(name)}`,
    );
  }
  if (intent === "new-outline") return redirect(`/b/${project.slug}/f/outline/${slug}.md`);
  throw new Response("Bad request", { status: 400 });
}

export default function BookBible({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canEdit, bible, others, hasBookFile } = loaderData;
  const file = (path: string) => `/b/${head.slug}/f/${path}`;

  return (
    <div className="app-page">
      <BookHead book={head} section="bible" />
      {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}

      <div className="app-split" data-aside>
        <Panel
          title="Bible"
          count={bible.length}
          footer={
            canEdit ? (
              <InlineAddForm Form={Form} hidden={{ intent: "new-bible" }} submit="Start it">
                <Field label="New entry" size="short">
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
                  <input
                    className="cap-input"
                    name="name"
                    required
                    placeholder="Name"
                    autoComplete="off"
                  />
                </Field>
              </InlineAddForm>
            ) : undefined
          }
        >
          <div className="app-bible">
            {KINDS.map(({ kind, heading }) => {
              const entries = bible.filter((b) => b.kind === kind);
              return (
                <section key={kind} className="app-section" aria-labelledby={`bible-${kind}`}>
                  <h3 id={`bible-${kind}`}>
                    {heading} <span className="cap-muted">{entries.length}</span>
                  </h3>
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
          </div>
        </Panel>

        <Panel
          title="Outline and notes"
          count={others.length}
          footer={
            canEdit ? (
              <InlineAddForm Form={Form} hidden={{ intent: "new-outline" }} submit="Start it">
                <Field label="New outline file">
                  <input
                    className="cap-input"
                    name="name"
                    required
                    placeholder="Name"
                    autoComplete="off"
                  />
                </Field>
              </InlineAddForm>
            ) : undefined
          }
        >
          {others.length === 0 && (hasBookFile || !canEdit) ? (
            <p className="cap-muted">None yet.</p>
          ) : (
            <ul className="app-links">
              {others.map((o) => (
                <li key={o.path}>
                  <Link to={file(o.path)}>
                    {o.kind === "book" ? "Title page (book.md)" : o.path}
                  </Link>
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
  );
}
