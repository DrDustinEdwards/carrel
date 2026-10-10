// The editor for one file in a book: a scene, a bible entry, an outline or the title page. The same
// CodeMirror editor as posts, autosave to D1 as you type, and Save, which commits to Git with the
// version the text started from. Beside a scene: its flags and the bible entries it names.

import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { WritingSurface } from "~/components/editor/writing-surface";
import { useTypingRecede } from "~/components/editor/typing";
import { PageHead } from "~/components/page-head";
import { Binder } from "~/components/writing/binder";

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
import { countProseWords, isBookPath, kindOf, TEMPLATES, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { addUntyped, clearUntyped, untypedField } from "~/lib/writing.server";
import { binderTree } from "~/lib/writing/binder";

import type { Route } from "./+types/book.file";

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

  const indexed = await listFiles(env.DB, project);
  // The bible entries a scene names, and every world rule, for the side panel.
  let bible: { path: string; name: string; kind: string; body: string }[] = [];
  if (kind === "scene") {
    const { data } = parseFile(source);
    const names = [data.pov, data.location, ...(Array.isArray(data.characters) ? data.characters : [])]
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .map((n) => n.trim().toLowerCase());
    const matched = indexed.flatMap(({ path, kind, meta }) => {
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
    binder: binderTree(indexed, `/b/${project.slug}`),
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
      await addUntyped(env.DB, project.id, viewer.id, path, untypedField(form.get("untyped")));
      return { intent, updatedAt: saved.updatedAt };
    }
    case "discard":
      await discardDraft(env.DB, project, viewer, path);
      await clearUntyped(env.DB, project.id, viewer.id, path);
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
      // The AI's words were not typed, so they never count toward the day (ruling 6).
      await addUntyped(env.DB, project.id, viewer.id, path, countProseWords(parseFile(ai.source).body));
      return { intent, used: id };
    }
    case "save": {
      const { repo, detail } = bookRepo(env);
      if (!repo) return { intent, outcome: { ok: false, reason: "failed", message: `${detail} Your text is kept here as your draft.` } };
      return { intent, outcome: await saveBookFile(env.DB, repo, project, viewer, path, { source, expectedVersion: version, untyped: untypedField(form.get("untyped")) }) };
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

type Ask = { kind: "discard" | "dismiss" | "use-ai"; id?: number; opener: HTMLElement | null };

function BookFile({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [source, setSource] = useState(data.source);
  // A file started from a template is not saved anywhere yet.
  const [savedSource, setSavedSource] = useState(data.fresh ? "" : data.source);
  const [savedAt, setSavedAt] = useState<string | null>(data.draftAt);
  const [asking, setAsking] = useState<Ask | null>(null);
  const autosaver = useFetcher<ActionResult>();
  const writer = useFetcher<ActionResult>();
  const checker = useFetcher<ActionResult>();
  const { say } = useMessage();
  useTypingRecede();
  const readOnly = !data.canEdit;
  const base = `/b/${data.project.slug}`;

  // Words pasted or dropped into the text and not yet reported: they reach the file but were not
  // typed, so the day's count leaves them out (ruling 6). Each submission carries the count, and the
  // part a submission carried comes off once the server has it.
  const untyped = useRef(0);
  const untypedSent = useRef({ autosave: 0, save: 0 });
  const countUntyped = (text: string | undefined) => {
    if (!readOnly && text) untyped.current += countProseWords(text);
  };

  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || source === savedSource || autosaver.state !== "idle") return;
    const timer = window.setTimeout(() => {
      inFlight.current = source;
      untypedSent.current.autosave = untyped.current;
      void autosaver.submit({ intent: "autosave", source, expectedVersion: data.baseVersion ?? "", untyped: String(untyped.current) }, { method: "post" });
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, savedSource, readOnly, data.baseVersion, autosaver.state]);

  useEffect(() => {
    if (autosaver.state !== "idle" || inFlight.current === null) return;
    if (autosaver.data?.intent === "autosave") {
      setSavedSource(inFlight.current);
      setSavedAt(autosaver.data.updatedAt);
      untyped.current = Math.max(0, untyped.current - untypedSent.current.autosave);
    }
    untypedSent.current.autosave = 0;
    inFlight.current = null;
  }, [autosaver.state, autosaver.data]);

  const discarded = writer.data?.intent === "discard" && writer.state === "idle";
  useEffect(() => {
    if (discarded) {
      untyped.current = 0;
      setSource(data.source);
      setSavedSource(data.source);
      setSavedAt(null);
    }
  }, [discarded, data.source]);

  // After Use as my draft, the loader has the AI draft as the working copy, which replaces the local one.
  const usedAi = writer.data?.intent === "use-ai-draft" && writer.state === "idle";
  useEffect(() => {
    if (usedAi) {
      // The text pasted into the draft it replaced is gone with it; the AI's words are counted by the server.
      untyped.current = 0;
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
      untyped.current = Math.max(0, untyped.current - untypedSent.current.save);
    }
    if (writer.state === "idle") untypedSent.current.save = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, writer.state]);

  // Said once in the message region, as each save finishes.
  const said = useRef<unknown>(null);
  useEffect(() => {
    if (!outcome?.ok || writer.state !== "idle" || said.current === outcome) return;
    said.current = outcome;
    say(`Saved to Git (${outcome.commit.slice(0, 7)}). ${outcome.findings.length === 0 ? "Nothing flagged." : `${outcome.findings.length} flag${outcome.findings.length === 1 ? "" : "s"}; see the list.`}`);
  }, [outcome, writer.state, say]);

  const send = (intent: string, extra: Record<string, string> = {}) => {
    if (intent === "save") untypedSent.current.save = untyped.current;
    return writer.submit({ intent, source, expectedVersion: data.baseVersion ?? "", untyped: String(intent === "save" ? untyped.current : 0), ...extra }, { method: "post" });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (data.canEdit && data.connected && writer.state === "idle") void send("save");
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
  const openFlags = data.findings.filter((f) => f.status === "open").length;
  const ask = (kind: Ask["kind"], opener: HTMLElement | null, id?: number) => setAsking({ kind, opener, id });

  const crumbs: { label: string; href?: string }[] = [{ label: data.project.name, href: base }];
  if (data.kind === "scene") crumbs.push({ label: titleFromSegment(data.path.split("/")[1]!), href: `${base}/c/${data.path.split("/")[1]}` });
  crumbs.push({ label: data.label });

  return (
    <div className="app-page app-editor">
      <PageHead
        crumbs={crumbs}
        title={data.label}
        lead={
          <>
            <span className="cap-mono">
              {data.project.book}/{data.path}
            </span>{" "}
            {data.version ? null : <Pill variant="outline">Not in Git yet</Pill>}
          </>
        }
        actions={
          data.version ? (
            <Link className="cap-btn" to={`${base}/h/${data.path}`}>
              History
            </Link>
          ) : undefined
        }
      />

      <div className="app-notices">
        {data.connectionDetail ? <Banner tone="warn">{data.connectionDetail}</Banner> : null}
        {data.behind ? (
          <Banner tone="warn" title="Git moved on">
            This file changed in Git after your draft was started, so saving it will be refused. Discard the draft to load Git's version, then reapply your changes.
          </Banner>
        ) : null}
        {data.problems.length > 0 ? (
          <Banner tone="warn" title="The header has lines Carrel does not read">
            {data.problems.map((p) => `line ${p.line}`).join(", ")}. Use key: value, key: [a, b], or one - item per line.
          </Banner>
        ) : null}
      </div>

      <div className="app-editor-grid">
        <div className="app-editor-main">
          <section
            className="app-editor-pane"
            aria-label="Write"
            onPasteCapture={(event) => countUntyped(event.clipboardData?.getData("text/plain"))}
            onDropCapture={(event) => countUntyped(event.dataTransfer?.getData("text/plain"))}
          >
            <WritingSurface label={data.kind === "scene" ? "Scene" : "File"} value={source} onChange={setSource} readOnly={readOnly} linkTargets={[]} />
          </section>
        </div>

        <aside className="app-editor-side" aria-label="Binder, saving, checks and the bible">
          <Panel title="Binder" src="The book in reading order">
            <Binder nodes={data.binder} book={data.project.slug} current={data.path} canEdit={data.canEdit && data.connected} />
          </Panel>

          {data.canEdit ? (
            <Panel title="This file" src={data.version ? "In Git" : "Only in Carrel so far"}>
              <div className="app-stack" data-tight>
                <p role="status" className="app-savestate">
                  {saveState}
                </p>
                {outcome && !outcome.ok ? <Alert tone="crit">{outcome.message}</Alert> : null}
                <div className="app-actions">
                  <Button variant="primary" pending={busy} disabledReason={!data.connected ? "Git is not connected, so saving waits. Your text is kept here as your draft." : undefined} onClick={() => send("save")}>
                    Save to Git
                  </Button>
                  <Button pending={checker.state !== "idle"} onClick={() => checker.submit({ intent: "check", source }, { method: "post" })}>
                    Check this text
                  </Button>
                  {savedAt ? (
                    <Button variant="quiet" pending={busy} onClick={(event) => ask("discard", event.currentTarget)}>
                      Discard my draft
                    </Button>
                  ) : null}
                </div>
              </div>
            </Panel>
          ) : null}

          <Panel title="Flags" count={openFlags} src="From the last save" id="flags">
            <div className="app-stack" data-tight>
              <p className="cap-muted app-note">A flag never stops a save; it holds export until it is fixed or the Owner dismisses it.</p>
              {data.findings.length === 0 ? (
                <p>None.</p>
              ) : (
                <ul className="app-flags" aria-label="Flags on this file">
                  {data.findings.map((f) => (
                    <li key={f.id}>
                      {f.status === "open" ? <Status tone="warn">Open</Status> : <Pill variant="secondary">Dismissed</Pill>}
                      <span>
                        <strong>{f.check}</strong> {f.line ? <span className="cap-muted">line {f.line}</span> : null} {f.message}
                      </span>
                      {f.status === "open" && data.canPublish ? (
                        <Button size="sm" onClick={(event) => ask("dismiss", event.currentTarget, f.id)}>
                          Dismiss<span className="cap-sr-only"> flag: {f.message}</span>
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {checked ? (
                <div role="status" className="app-stack" data-tight>
                  <h3 className="app-subhead">This text, checked now</h3>
                  {checked.length === 0 ? (
                    <p>Nothing flagged.</p>
                  ) : (
                    <ul className="app-flags">
                      {checked.map((f, i) => (
                        <li key={i}>
                          <Status tone="warn">Found</Status>
                          <span>
                            <strong>{f.check}</strong> {f.line ? <span className="cap-muted">line {f.line}</span> : null} {f.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </Panel>

          {data.aiDrafts.length > 0 ? (
            <Panel title="AI drafts beside yours" count={data.aiDrafts.length} src="None has touched your draft or Git">
              <div className="app-stack" data-tight>
                {data.aiDrafts.map((d) => (
                  <Disclosure
                    key={d.id}
                    summary={
                      <>
                        {d.client}{" "}
                        <span className="cap-muted">
                          <Time at={d.createdAt} /> · {d.words} words
                        </span>
                      </>
                    }
                  >
                    {d.note ? <p>{d.note}</p> : null}
                    <p className="app-bible-body">{d.source}</p>
                    <div className="app-actions">
                      <Link className="cap-btn" data-size="sm" to={`${base}/h/${data.path}?compare=ai&ai=${d.id}`}>
                        Compare with yours
                      </Link>
                      {data.canEdit ? (
                        <Button size="sm" pending={busy} onClick={(event) => ask("use-ai", event.currentTarget, d.id)}>
                          Use as my draft
                        </Button>
                      ) : null}
                    </div>
                  </Disclosure>
                ))}
              </div>
            </Panel>
          ) : null}

          {data.kind === "scene" ? (
            <Panel title="From the bible" count={data.bible.length}>
              {data.bible.length === 0 ? (
                <p className="cap-muted">No entries match this scene's header.</p>
              ) : (
                <div className="app-stack" data-tight>
                  {data.bible.map((b) => (
                    <Disclosure
                      key={b.path}
                      summary={
                        <>
                          {b.name} <span className="cap-muted">{b.kind}</span>
                        </>
                      }
                    >
                      <p className="app-bible-body">{b.body || "(no notes)"}</p>
                      <Link to={`${base}/f/${b.path}`}>Open</Link>
                    </Disclosure>
                  ))}
                </div>
              )}
            </Panel>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={asking?.kind === "discard"}
        title="Discard your draft?"
        lead="Your working copy in Carrel is deleted, and the editor goes back to Git's text. This cannot be undone."
        body={[]}
        action="Discard my draft"
        returnTo={asking?.opener}
        perform={async () => void (await writer.submit({ intent: "discard" }, { method: "post" }))}
        onClose={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.kind === "dismiss"}
        title="Dismiss this flag?"
        lead="A dismissed flag no longer holds export, and it cannot be reopened."
        body={asking?.id !== undefined ? [data.findings.find((f) => f.id === asking.id)?.message ?? ""] : []}
        action="Dismiss flag"
        returnTo={asking?.opener}
        perform={async () => {
          if (asking?.id !== undefined) await writer.submit({ intent: "dismiss", finding: String(asking.id) }, { method: "post" });
        }}
        onClose={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.kind === "use-ai"}
        title="Use the AI draft as your draft?"
        lead="Its text replaces your working draft, which you then edit and save as usual. Your current draft is not kept."
        body={[]}
        action="Replace my draft"
        returnTo={asking?.opener}
        perform={async () => {
          if (asking?.id !== undefined) await writer.submit({ intent: "use-ai-draft", draft: String(asking.id) }, { method: "post" });
        }}
        onClose={() => setAsking(null)}
      />
    </div>
  );
}
