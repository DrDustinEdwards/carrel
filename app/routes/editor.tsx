// The editor for one site item: the copied CodeMirror editor in a prose layout, autosave to D1 as
// you type, the site's own render in a sandboxed preview, and the writes the viewer's role allows.

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";

import type { LinkTarget } from "~/components/editor/markdown-editor";
import { dismissItemFinding, itemFindings, lastAiPublication, listAiDrafts, publishedByLine } from "~/lib/ai.server";
import { autosave, discardDraft, readDoc, readDraft, writeToSite, type WriteOutcome } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { searchItems } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { FIRST_PUBLICATION_NOTE, transitionsFor } from "~/lib/publish-transition.mjs";
import { can } from "~/lib/roles";
import { siteEntry, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/editor";

const MarkdownEditor = lazy(() => import("~/components/editor/markdown-editor"));

const AUTOSAVE_DELAY_MS = 1200;
const LAYOUT_KEY = "carrel:editor-layout";
type Layout = "write" | "split" | "preview";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.title || data.itemId} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const itemId = params.item;

  const draft = await readDraft(env.DB, project, viewer, itemId);
  let doc = null;
  let siteError: string | null = null;
  try {
    doc = await readDoc(env, project, itemId);
  } catch (error) {
    siteError = error instanceof SiteNotConnected ? error.detail : "The site did not answer, so this shows your Carrel draft only.";
  }
  if (!doc && !draft && !siteError) throw new Response("Not found", { status: 404 });

  const [targets, flags, aiDrafts, aiPublished] = await Promise.all([
    searchItems(env.DB, project.id, {}),
    itemFindings(env.DB, project, itemId),
    listAiDrafts(env.DB, project, viewer, itemId),
    lastAiPublication(env.DB, project, itemId),
  ]);
  const linkTargets: LinkTarget[] = targets
    .filter((t) => t.itemId !== itemId)
    .map((t) => ({ slug: t.itemId, title: t.title || t.itemId, state: t.status }));

  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    itemId,
    canEdit: can(project.role, "edit"),
    canPublish: can(project.role, "publish"),
    title: doc?.title ?? "",
    status: doc?.status ?? null,
    path: doc?.path ?? null,
    everPublished: Boolean(doc?.publishedAt),
    publishAt: doc?.publishAt ?? null,
    version: doc?.version ?? null,
    source: draft?.source ?? doc?.source ?? "",
    baseVersion: draft ? draft.baseVersion : (doc?.version ?? null),
    draftAt: draft?.updatedAt ?? null,
    // The site moved on since this draft was started: saving it would be refused as stale.
    behind: Boolean(draft && doc && draft.baseVersion !== doc.version),
    siteError,
    linkTargets,
    flags,
    aiDrafts,
    aiPublished: aiPublished ? { line: publishedByLine(aiPublished.client), at: aiPublished.publishedAt } : null,
  };
}

type ActionResult =
  | { intent: "autosave"; updatedAt: string }
  | { intent: "discard"; discarded: true }
  | { intent: "publish"; needsConfirm: true }
  | { intent: "dismiss-flag"; dismissed: number }
  | { intent: "write"; outcome: WriteOutcome };

export async function action({ params, request, context }: Route.ActionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const itemId = params.item;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const source = String(form.get("source") ?? "").replace(/\r\n/g, "\n");
  const version = String(form.get("expectedVersion") ?? "") || null;

  switch (intent) {
    case "autosave": {
      const saved = await autosave(env.DB, project, viewer, itemId, { source, baseVersion: version });
      return { intent, updatedAt: saved.updatedAt };
    }
    case "discard":
      await discardDraft(env.DB, project, viewer, itemId);
      return { intent, discarded: true };
    case "dismiss-flag": {
      const id = Number(form.get("flag"));
      if (!Number.isInteger(id)) throw new Response("Bad request", { status: 400 });
      await dismissItemFinding(env.DB, project, viewer, itemId, id);
      return { intent, dismissed: id };
    }
    case "save":
      return { intent: "write", outcome: await writeToSite(env, project, viewer, itemId, { action: "save", source, expectedVersion: version }) };
    case "publish": {
      // Refused before the ceremony, so a person who may not publish is never asked to confirm.
      if (!can(project.role, "publish")) throw new Response("Forbidden", { status: 403 });
      if (!version) throw new Response("Save the post to the site before publishing it.", { status: 400 });
      const current = await readDoc(env, project, itemId);
      // The site's ceremony, kept: a post that has never been public is published only on a second, explicit ask.
      if (current && !current.publishedAt && form.get("confirm") !== "first-publish") return { intent, needsConfirm: true };
      return { intent: "write", outcome: await writeToSite(env, project, viewer, itemId, { action: "publish", source, expectedVersion: version }) };
    }
    case "schedule": {
      const publishAt = String(form.get("publishAt") ?? "");
      if (!version || Number.isNaN(Date.parse(publishAt))) throw new Response("A schedule needs a saved post and a time.", { status: 400 });
      return {
        intent: "write",
        outcome: await writeToSite(env, project, viewer, itemId, {
          action: "schedule",
          source,
          expectedVersion: version,
          publishAt: new Date(publishAt).toISOString(),
        }),
      };
    }
    case "unpublish":
      if (!version) throw new Response("Only a post on the site can be unpublished.", { status: 400 });
      return { intent: "write", outcome: await writeToSite(env, project, viewer, itemId, { action: "unpublish", expectedVersion: version }) };
    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/** Autosave writes only the viewer's own draft, so the page has nothing to reload, and the site is not asked. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "autosave") return false;
  return defaultShouldRevalidate;
}

export default function EditorRoute({ loaderData }: Route.ComponentProps) {
  // A new item gets a fresh editor, not the last item's cursor and history.
  return <Editor key={`${loaderData.project.slug}/${loaderData.itemId}`} data={loaderData} />;
}

function Editor({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [source, setSource] = useState(data.source);
  const [savedSource, setSavedSource] = useState(data.source);
  const [savedAt, setSavedAt] = useState<string | null>(data.draftAt);
  const [layout, setLayout] = useState<Layout>("write");
  const [typing, setTyping] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const autosaver = useFetcher<ActionResult>();
  const writer = useFetcher<ActionResult>();

  const readOnly = !data.canEdit;
  const openFlags = data.flags.filter((f) => f.status === "open").length;
  const live = data.status === "published" || data.status === "scheduled";
  const onSite = data.version !== null;
  // Changes to a live post change the public site, which is the Owner's to do.
  const maySave = data.canEdit && (!live || data.canPublish);

  // Remembered in this browser; read after mount so the server and the first client paint agree.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAYOUT_KEY);
      if (stored === "write" || stored === "split" || stored === "preview") setLayout(stored);
    } catch {
      // Storage disabled: Write, the default.
    }
  }, []);
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // As above.
    }
  };

  // Autosave a beat after typing stops. The base version travels with it, so a later save is checked
  // against the version this draft started from.
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

  // Counted as saved only once the server said so; a failed autosave leaves the text unsaved and retried.
  useEffect(() => {
    if (autosaver.state !== "idle" || inFlight.current === null) return;
    if (autosaver.data?.intent === "autosave") {
      setSavedSource(inFlight.current);
      setSavedAt(autosaver.data.updatedAt);
    }
    inFlight.current = null;
  }, [autosaver.state, autosaver.data]);

  // After a discard, the loader has the site's text again, which replaces the local copy.
  const discarded = writer.data?.intent === "discard" && writer.state === "idle";
  useEffect(() => {
    if (discarded) {
      setSource(data.source);
      setSavedSource(data.source);
      setSavedAt(null);
    }
  }, [discarded, data.source]);

  // A write that reached the site clears the draft there, so the local copy counts as saved.
  const outcome = writer.data?.intent === "write" ? writer.data.outcome : null;
  useEffect(() => {
    if (outcome?.ok && writer.state === "idle") {
      setSavedSource(source);
      setSavedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, writer.state]);

  const send = (intent: string, extra: Record<string, string> = {}) =>
    writer.submit({ intent, source, expectedVersion: data.baseVersion ?? "", ...extra }, { method: "post" });

  // Cmd+S saves in place: a draft stays a draft, a live post is updated.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (maySave && writer.state === "idle") send("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const busy = writer.state !== "idle";
  const needsConfirm = writer.data?.intent === "publish" && writer.data.needsConfirm && !busy;
  const transitions = data.status ? transitionsFor(data.status === "draft" ? "draft" : "published", data.everPublished) : [];
  const saveState =
    autosaver.state !== "idle" ? "Saving to Carrel" : source !== savedSource ? "Not yet saved" : savedAt ? `Draft saved in Carrel ${new Date(savedAt).toLocaleTimeString()}` : onSite ? "Matches the site" : "";
  const previewSrc = `preview?at=${encodeURIComponent(savedAt ?? data.version ?? "")}`;

  return (
    <div
      className="editor-shell"
      data-layout={layout}
      data-typing={typing ? "" : undefined}
      onKeyDown={(event) => {
        if (!event.metaKey && !event.ctrlKey && event.key.length === 1) setTyping(true);
      }}
      onMouseMove={() => typing && setTyping(false)}
    >
      <header className="editor-chrome">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={`/p/${data.project.slug}`}>{data.project.name}</Link>
        </p>
        <div className="editor-title">
          <h1>{data.title || data.itemId}</h1>
          <p className="muted">
            {data.status ? <span className={`status status-${data.status}`}>{data.status}</span> : <span className="status">not on the site yet</span>}{" "}
            {data.path ? <span>{data.path}</span> : null} <span role="status">{saveState}</span>
          </p>
        </div>
        <div className="editor-layouts" role="radiogroup" aria-label="Layout">
          {(["write", "split", "preview"] as const).map((l) => (
            <button key={l} type="button" role="radio" aria-checked={layout === l} className="layout-option" onClick={() => chooseLayout(l)}>
              {l === "write" ? "Write" : l === "split" ? "Split" : "Preview"}
            </button>
          ))}
        </div>
      </header>

      {data.siteError ? (
        <p className="notice" role="status">
          {data.siteError}
        </p>
      ) : null}
      {data.behind ? (
        <p className="notice" role="status">
          The site's copy changed after this draft was started, so saving it will be refused. Discard the draft to load the site's version, then reapply your changes.
        </p>
      ) : null}
      {data.aiPublished && data.status === "published" ? (
        <p className="notice" role="status">
          {data.aiPublished.line} <span className="muted">({new Date(data.aiPublished.at).toLocaleString()})</span>
        </p>
      ) : null}
      {data.flags.length > 0 || data.aiDrafts.length > 0 ? (
        <details className="editor-extras" open={openFlags > 0}>
          <summary>
            {openFlags} open flag{openFlags === 1 ? "" : "s"}, {data.aiDrafts.length} AI draft{data.aiDrafts.length === 1 ? "" : "s"}
          </summary>
          {data.flags.length > 0 ? (
            <ul className="flag-list" aria-label="Flags">
              {data.flags.map((f) => (
                <li key={f.id}>
                  <span className={f.status === "open" ? "flag-open" : "muted"}>{f.status === "open" ? "Open" : "Dismissed"}</span> {f.message}
                  {f.excerpt ? <q className="muted"> {f.excerpt}</q> : null}
                  {f.status === "open" && data.canPublish ? (
                    <button type="button" className="btn-ghost" onClick={() => writer.submit({ intent: "dismiss-flag", flag: String(f.id) }, { method: "post" })}>
                      Dismiss
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {data.aiDrafts.length > 0 ? (
            <ul className="flag-list" aria-label="AI drafts beside yours">
              {data.aiDrafts.map((d) => (
                <li key={d.id}>
                  <Link to={`ai/${d.id}`}>AI draft from {d.client}</Link> <span className="muted">{new Date(d.createdAt).toLocaleString()} · {d.words} words</span>
                  {d.note ? <span> · {d.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
      {data.canEdit && live && !data.canPublish ? (
        <p className="notice" role="status">
          This post is live. Your changes autosave here as your draft; sending them to the site is the Owner's step.
        </p>
      ) : null}

      <div className="editor-body">
        {layout !== "preview" ? (
          <section className="editor-pane" aria-label="Write">
            <Suspense fallback={<p className="muted editor-loading">Loading the editor</p>}>
              <MarkdownEditor
                value={source}
                onChange={setSource}
                onReady={() => undefined}
                slug={data.itemId}
                linkTargets={data.linkTargets}
                readOnly={readOnly}
              />
            </Suspense>
          </section>
        ) : null}
        {layout !== "write" ? (
          <section className="preview-pane" aria-label="Preview">
            {/* Sandboxed with no permissions: the site's page runs no script and has an opaque origin. */}
            <iframe title={`Preview of ${data.title || data.itemId} as ${data.project.site} renders it`} src={previewSrc} sandbox="" />
          </section>
        ) : null}
      </div>

      <footer className="editor-chrome editor-actions">
        {outcome && !outcome.ok ? (
          <p className="alarm" role="alert">
            {outcome.message}
          </p>
        ) : outcome?.ok ? (
          <p className="muted" role="status">
            {outcome.action === "save" ? "Saved to the site." : outcome.action === "publish" ? "Published." : outcome.action === "schedule" ? "Scheduled." : "Returned to draft."}
          </p>
        ) : null}

        {needsConfirm ? (
          <div className="confirm" role="group" aria-label="Confirm first publication">
            <p>{FIRST_PUBLICATION_NOTE}</p>
            <button type="button" className="btn" onClick={() => send("publish", { confirm: "first-publish" })}>
              Publish now
            </button>
          </div>
        ) : null}

        <div className="actions">
          {data.canEdit && savedAt ? (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => send("discard")}>
              Discard my draft
            </button>
          ) : null}

          {!onSite && maySave ? (
            <button type="button" className="btn" disabled={busy} onClick={() => send("save")}>
              Save draft to the site
            </button>
          ) : null}

          {onSite
            ? transitions.map((t) => {
                const isSave = t.id === "save-draft" || t.id === "save";
                const allowed = isSave ? maySave : data.canPublish;
                if (!allowed) return null;
                const intent = isSave ? "save" : t.id === "unpublish" ? "unpublish" : "publish";
                return (
                  <button key={t.id} type="button" className={t.danger ? "btn-danger" : isSave ? "btn-ghost" : "btn"} disabled={busy} onClick={() => send(intent)}>
                    {t.label}
                  </button>
                );
              })
            : null}

          {onSite && data.canPublish && data.status !== "published" ? (
            <span className="schedule">
              <label className="field-inline">
                <span>Publish at</span>
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              </label>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy || !scheduleAt}
                onClick={() => send("schedule", { publishAt: new Date(scheduleAt).toISOString() })}
              >
                Schedule
              </button>
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
