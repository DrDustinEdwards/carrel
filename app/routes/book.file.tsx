// The editor for one file in a book: a scene, a bible entry, an outline or the title page. The same
// CodeMirror editor as posts, autosave to D1 as you type, and Save, which commits to Git with the
// version the text started from. Beside a scene: its flags and the bible entries it names.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";

import {
  bookRepo,
  checkDraft,
  dismissFinding,
  indexedFile,
  listFiles,
  listFindings,
  requireBookProject,
  saveBookFile,
  type BookWrite,
} from "~/lib/books.server";
import { listAiDrafts, readAiDraft } from "~/lib/ai.server";
import { autosave, discardDraft, readDraft } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import type { Finding } from "~/lib/novels/checks";
import { parseFile } from "~/lib/novels/frontmatter";
import { isBookPath, kindOf, TEMPLATES, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";

import type { Route } from "./+types/book.file";

const MarkdownEditor = lazy(() => import("~/components/editor/markdown-editor"));

const AUTOSAVE_DELAY_MS = 1200;

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.label} · ${data.project.name} · Carrel` : "Carrel" }];
}

function starter(path: string, name: string | null, bookName: string): string {
  const kind = kindOf(path);
  const fallback = titleFromSegment(path.split("/").pop()!.replace(/\.md$/, ""));
  if (kind === "scene") return TEMPLATES.scene("");
  if (kind === "character" || kind === "place" || kind === "rule") return TEMPLATES[kind](name?.trim() || fallback);
  if (kind === "book") return ["---", `title: ${bookName}`, "author:", "language: en", "---", "", ""].join("\n");
  return `# ${fallback}\n\n`;
}

function labelFor(path: string): string {
  const kind = kindOf(path);
  const file = titleFromSegment(path.split("/").pop()!.replace(/\.md$/, ""));
  if (kind === "scene") return `${titleFromSegment(path.split("/")[1]!)}: ${file}`;
  if (kind === "book") return "Title page";
  return file;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const path = params["*"] ?? "";
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });

  const draft = await readDraft(env.DB, project, viewer, path);
  const { repo, detail } = bookRepo(env);
  let git: { source: string; sha: string } | null = null;
  let gitError: string | null = null;
  if (repo) {
    try {
      git = await repo.read(`${project.book}/${path}`);
    } catch (error) {
      gitError = `Git did not answer (${error instanceof Error ? error.message : String(error)}), so this shows Carrel's index.`;
    }
  }
  // Without Git, the index's copy stands in, read-only for saving but fine for reading.
  const file = git ?? (!repo || gitError ? await indexedFile(env.DB, project, path) : null);
  const canEdit = can(project.role, "edit");
  const fresh = !file && !draft;
  if (fresh && !canEdit) throw new Response("Not found", { status: 404 });

  const kind = kindOf(path);
  const source = draft?.source ?? file?.source ?? starter(path, new URL(request.url).searchParams.get("name"), project.name);

  // The bible entries a scene names, and every world rule, for the side panel.
  let bible: { path: string; name: string; kind: string; body: string }[] = [];
  if (kind === "scene") {
    const { data } = parseFile(source);
    const names = [data.pov, data.location, ...(Array.isArray(data.characters) ? data.characters : [])]
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .map((n) => n.trim().toLowerCase());
    const files = await listFiles(env.DB, project);
    const matched = files.flatMap(({ path, kind, meta }) => {
      if (meta.kind === "rule") return [{ path, kind, name: meta.entry.name }];
      if (meta.kind !== "character" && meta.kind !== "place") return [];
      const hit = [meta.entry.name, ...meta.entry.aliases].some((n) => names.includes(n.toLowerCase()));
      return hit ? [{ path, kind, name: meta.entry.name }] : [];
    });
    bible = await Promise.all(
      matched.map(async (m) => ({
        ...m,
        body: parseFile((await indexedFile(env.DB, project, m.path))?.source ?? "").body.trim().slice(0, 600),
      })),
    );
  }

  return {
    project: { slug: project.slug, name: project.name, book: project.book },
    path,
    kind,
    label: labelFor(path),
    canEdit,
    canPublish: can(project.role, "publish"),
    connected: repo !== null,
    connectionDetail: detail ?? gitError,
    source,
    baseVersion: draft ? draft.baseVersion : (file?.sha ?? null),
    version: git?.sha ?? file?.sha ?? null,
    draftAt: draft?.updatedAt ?? null,
    fresh,
    // Git moved on since this draft was started: saving it would be refused as stale.
    behind: Boolean(draft && git && draft.baseVersion !== git.sha),
    findings: await listFindings(env.DB, project, { path }),
    problems: parseFile(source).problems,
    bible,
    // AI drafts an AI session saved beside this person's own, with their text: never committed.
    aiDrafts: await Promise.all(
      (await listAiDrafts(env.DB, project, viewer, path)).map(async (d) => ({ ...d, source: (await readAiDraft(env.DB, project, viewer, path, d.id)).source })),
    ),
  };
}

type ActionResult =
  | { intent: "autosave"; updatedAt: string }
  | { intent: "discard"; discarded: true }
  | { intent: "check"; findings: Finding[] }
  | { intent: "dismiss"; dismissed: number }
  | { intent: "use-ai-draft"; used: number }
  | { intent: "save"; outcome: BookWrite };

export async function action({ params, request, context }: Route.ActionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const path = params["*"] ?? "";
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const source = String(form.get("source") ?? "").replace(/\r\n/g, "\n");
  const version = String(form.get("expectedVersion") ?? "") || null;

  switch (intent) {
    case "autosave": {
      const saved = await autosave(env.DB, project, viewer, path, { source, baseVersion: version });
      return { intent, updatedAt: saved.updatedAt };
    }
    case "discard":
      await discardDraft(env.DB, project, viewer, path);
      return { intent, discarded: true };
    case "check":
      return { intent, findings: await checkDraft(env.DB, project, path, source) };
    case "dismiss": {
      const id = Number(form.get("finding"));
      if (!Number.isInteger(id)) throw new Response("Bad request", { status: 400 });
      await dismissFinding(env.DB, project, viewer, id);
      return { intent, dismissed: id };
    }
    case "use-ai-draft": {
      // The person's decision: the AI draft's text becomes their working draft, to edit and save.
      const id = Number(form.get("draft"));
      if (!Number.isInteger(id)) throw new Response("Bad request", { status: 400 });
      const ai = await readAiDraft(env.DB, project, viewer, path, id);
      await autosave(env.DB, project, viewer, path, { source: ai.source, baseVersion: ai.baseVersion });
      return { intent, used: id };
    }
    case "save": {
      const { repo, detail } = bookRepo(env);
      if (!repo) return { intent, outcome: { ok: false, reason: "failed", message: `${detail} Your text is kept here as your draft.` } };
      return { intent, outcome: await saveBookFile(env.DB, repo, project, viewer, path, { source, expectedVersion: version }) };
    }
    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/** Autosave and a check write nothing the page shows, so the page has nothing to reload and Git is not asked. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const intent = formData?.get("intent");
  if (intent === "autosave" || intent === "check") return false;
  return defaultShouldRevalidate;
}

export default function BookFileRoute({ loaderData }: Route.ComponentProps) {
  return <BookFile key={`${loaderData.project.slug}/${loaderData.path}`} data={loaderData} />;
}

function BookFile({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [source, setSource] = useState(data.source);
  // A file started from a template is not saved anywhere yet.
  const [savedSource, setSavedSource] = useState(data.fresh ? "" : data.source);
  const [savedAt, setSavedAt] = useState<string | null>(data.draftAt);
  const autosaver = useFetcher<ActionResult>();
  const writer = useFetcher<ActionResult>();
  const checker = useFetcher<ActionResult>();
  const readOnly = !data.canEdit;
  const base = `/b/${data.project.slug}`;

  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || source === savedSource || autosaver.state !== "idle") return;
    const timer = window.setTimeout(() => {
      inFlight.current = source;
      autosaver.submit({ intent: "autosave", source, expectedVersion: data.baseVersion ?? "" }, { method: "post" });
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, savedSource, readOnly, data.baseVersion, autosaver.state]);

  useEffect(() => {
    if (autosaver.state !== "idle" || inFlight.current === null) return;
    if (autosaver.data?.intent === "autosave") {
      setSavedSource(inFlight.current);
      setSavedAt(autosaver.data.updatedAt);
    }
    inFlight.current = null;
  }, [autosaver.state, autosaver.data]);

  const discarded = writer.data?.intent === "discard" && writer.state === "idle";
  useEffect(() => {
    if (discarded) {
      setSource(data.source);
      setSavedSource(data.source);
      setSavedAt(null);
    }
  }, [discarded, data.source]);

  // After Use as my draft, the loader has the AI draft as the working copy, which replaces the local one.
  const usedAi = writer.data?.intent === "use-ai-draft" && writer.state === "idle";
  useEffect(() => {
    if (usedAi) {
      setSource(data.source);
      setSavedSource(data.source);
      setSavedAt(data.draftAt);
    }
  }, [usedAi, data.source, data.draftAt]);

  const outcome = writer.data?.intent === "save" ? writer.data.outcome : null;
  useEffect(() => {
    if (outcome?.ok && writer.state === "idle") {
      setSavedSource(source);
      setSavedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, writer.state]);

  const send = (intent: string, extra: Record<string, string> = {}) =>
    writer.submit({ intent, source, expectedVersion: data.baseVersion ?? "", ...extra }, { method: "post" });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (data.canEdit && data.connected && writer.state === "idle") send("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const busy = writer.state !== "idle";
  const checked = checker.data?.intent === "check" ? checker.data.findings : null;
  const saveState =
    autosaver.state !== "idle"
      ? "Saving to Carrel"
      : source !== savedSource
        ? "Not yet saved"
        : savedAt
          ? `Draft saved in Carrel ${new Date(savedAt).toLocaleTimeString()}`
          : data.version
            ? "Matches Git"
            : "";

  return (
    <div className="editor-shell book-editor">
      <header className="editor-chrome">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={base}>{data.project.name}</Link>
          {data.kind === "scene" ? (
            <>
              {" "}
              / <Link to={`${base}/c/${data.path.split("/")[1]}`}>{titleFromSegment(data.path.split("/")[1]!)}</Link>
            </>
          ) : null}
        </p>
        <div className="editor-title">
          <h1>{data.label}</h1>
          <p className="muted">
            <span className="item-id">
              {data.project.book}/{data.path}
            </span>{" "}
            {data.version ? null : <span className="status">not in Git yet</span>} <span role="status">{saveState}</span>
          </p>
        </div>
      </header>

      {data.connectionDetail ? (
        <p className="notice" role="status">
          {data.connectionDetail}
        </p>
      ) : null}
      {data.behind ? (
        <p className="notice" role="status">
          This file changed in Git after your draft was started, so saving it will be refused. Discard the draft to load Git's version, then reapply your changes.
        </p>
      ) : null}
      {data.problems.length > 0 ? (
        <p className="notice" role="status">
          The header has lines Carrel does not read: {data.problems.map((p) => `line ${p.line}`).join(", ")}. Use key: value, key: [a, b], or one - item per line.
        </p>
      ) : null}

      <div className="editor-body book-body">
        <section className="editor-pane" aria-label="Write">
          <Suspense fallback={<p className="muted editor-loading">Loading the editor</p>}>
            <MarkdownEditor value={source} onChange={setSource} onReady={() => undefined} slug={data.path} linkTargets={[]} readOnly={readOnly} />
          </Suspense>
        </section>

        <aside className="book-aside" aria-label="Checks and bible">
          <section aria-labelledby="flags-heading">
            <h2 id="flags-heading">Flags</h2>
            <p className="muted">From the last save. A flag never stops a save; it holds export until it is fixed or the Owner dismisses it.</p>
            {data.findings.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="findings">
                {data.findings.map((f) => (
                  <li key={f.id} className={`finding finding-${f.status}`}>
                    <span className="finding-check">{f.check}</span> {f.line ? <span className="muted">line {f.line}</span> : null}
                    <p>{f.message}</p>
                    {f.status === "dismissed" ? (
                      <p className="muted">Dismissed.</p>
                    ) : data.canPublish ? (
                      <button type="button" className="btn-ghost" disabled={busy} onClick={() => writer.submit({ intent: "dismiss", finding: String(f.id) }, { method: "post" })}>
                        Dismiss
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {checked ? (
              <div role="status">
                <h3>This text, checked now</h3>
                {checked.length === 0 ? (
                  <p className="muted">Nothing flagged.</p>
                ) : (
                  <ul className="findings">
                    {checked.map((f, i) => (
                      <li key={i} className="finding">
                        <span className="finding-check">{f.check}</span> {f.line ? <span className="muted">line {f.line}</span> : null}
                        <p>{f.message}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </section>

          {data.aiDrafts.length > 0 ? (
            <section aria-labelledby="ai-drafts-heading">
              <h2 id="ai-drafts-heading">AI drafts beside yours</h2>
              <p className="muted">Written by an AI session. None has touched your draft or Git.</p>
              {data.aiDrafts.map((d) => (
                <details key={d.id} className="bible-entry">
                  <summary>
                    {d.client} <span className="muted">{new Date(d.createdAt).toLocaleString()} · {d.words} words</span>
                  </summary>
                  {d.note ? <p>{d.note}</p> : null}
                  <p className="bible-body">{d.source}</p>
                  {data.canEdit ? (
                    <button type="button" className="btn-ghost" disabled={busy} onClick={() => writer.submit({ intent: "use-ai-draft", draft: String(d.id) }, { method: "post" })}>
                      Use as my draft
                    </button>
                  ) : null}
                </details>
              ))}
            </section>
          ) : null}

          {data.kind === "scene" ? (
            <section aria-labelledby="bible-heading">
              <h2 id="bible-heading">From the bible</h2>
              {data.bible.length === 0 ? (
                <p className="muted">No entries match this scene's header.</p>
              ) : (
                data.bible.map((b) => (
                  <details key={b.path} className="bible-entry">
                    <summary>
                      {b.name} <span className="muted">{b.kind}</span>
                    </summary>
                    <p className="bible-body">{b.body || "(no notes)"}</p>
                    <Link to={`${base}/f/${b.path}`}>Open</Link>
                  </details>
                ))
              )}
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="editor-chrome editor-actions">
        {outcome && !outcome.ok ? (
          <p className="alarm" role="alert">
            {outcome.message}
          </p>
        ) : outcome?.ok ? (
          <p className="muted" role="status">
            Saved to Git ({outcome.commit.slice(0, 7)}).{" "}
            {outcome.findings.length === 0 ? "Nothing flagged." : `${outcome.findings.length} flag${outcome.findings.length === 1 ? "" : "s"}; see the list.`}
          </p>
        ) : null}
        <div className="actions">
          {data.canEdit && savedAt ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => send("discard")}>
              Discard my draft
            </button>
          ) : null}
          <button
            type="button"
            className="btn-ghost"
            disabled={checker.state !== "idle"}
            onClick={() => checker.submit({ intent: "check", source }, { method: "post" })}
          >
            Check this text
          </button>
          {data.canEdit ? (
            <button type="button" className="btn" disabled={busy || !data.connected} onClick={() => send("save")}>
              Save to Git
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
