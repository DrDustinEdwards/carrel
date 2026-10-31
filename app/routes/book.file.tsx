// The editor for one file in a book: a scene, a bible entry, an outline or the title page. The same
// editor as posts, in the file's live room, where everyone on the book works on one copy at once with
// comments and suggestions, and Save, which commits the room's text to Git with the version it started
// from. Beside a scene: its flags and the bible entries it names.

import { useEffect, useRef, useState } from "react";
import { useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import { Link } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { useRoomEditing } from "~/components/editor/room-editing";
import { WritingSurface } from "~/components/editor/writing-surface";
import { useSaveShortcut } from "~/components/editor/save-keys";
import { useTypingRecede } from "~/components/editor/typing";
import { RouterLink } from "~/components/frame";
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
import { roomNames } from "~/lib/comments.server";
import { discardDraft, readDraft, readOwnDraft } from "~/lib/content.server";
import type { RoomViewer } from "~/lib/editor/room-protocol";
import { getEnv, getViewer } from "~/lib/context";
import type { Finding } from "~/lib/novels/checks";
import { parseFile } from "~/lib/novels/frontmatter";
import { countProseWords, isBookPath, fileKindOf, TEMPLATES, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { openRoom, replaceRoom, roomPath, roomVersion, saveRoom } from "~/lib/rooms.server";
import { addUntyped, clearUntyped, untypedField } from "~/lib/writing.server";
import { binderTree } from "~/lib/writing/binder";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.file";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.label} · ${data.project.name} · Carrel` : "Carrel" }];
}

function starter(path: string, name: string | null, bookName: string): string {
  const kind = fileKindOf(path);
  const fallback = titleFromSegment(path.split("/").pop()!.replace(/\.md$/, ""));
  if (kind === "scene") return TEMPLATES.scene("");
  if (kind === "character" || kind === "place" || kind === "rule") return TEMPLATES[kind](name?.trim() || fallback);
  if (kind === "book") return ["---", `title: ${bookName}`, "author:", "language: en", "---", "", ""].join("\n");
  return `# ${fallback}\n\n`;
}

function labelFor(path: string): string {
  const kind = fileKindOf(path);
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
  const fresh = !file && !(await readDraft(env.DB, project, viewer, path));
  if (fresh && !canEdit) throw new Response("Not found", { status: 404 });

  // Everyone on the book works on the file in its room, started the first time from Git (or the
  // index standing in for it), or from the template for a new file.
  const opened = await openRoom(env, project, viewer, path, {
    dialect: "plain",
    current: file ? { source: file.source, version: file.sha } : null,
    starter: starter(path, new URL(request.url).searchParams.get("name"), project.name),
  });
  const roomViewer: RoomViewer = { id: viewer.id, name: viewer.name || viewer.email, role: project.role, access: canEdit ? "edit" : "suggest" };

  const kind = fileKindOf(path);
  const source = opened?.source ?? file?.source ?? "";

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
    baseVersion: opened?.version ?? file?.sha ?? null,
    version: git?.sha ?? file?.sha ?? null,
    unsaved: opened?.unsaved ?? false,
    ownDraft: opened?.ownDraft ?? null,
    // Git moved on since the room's copy was started: saving it would be refused as stale.
    behind: opened?.behind ?? false,
    room: opened ? { path: roomPath("b", project.slug, path), viewer: roomViewer, names: await roomNames(env.DB, project.id) } : null,
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
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const source = String(form.get("source") ?? "").replace(/\r\n/g, "\n");

  switch (intent) {
    case "discard": {
      // Everyone in the room goes back to Git's text.
      const { repo } = bookRepo(env);
      const git = repo ? await repo.read(`${project.book}/${path}`).catch(() => null) : null;
      const file = git ?? (await indexedFile(env.DB, project, path));
      if (!file) throw new Response("Only a file in Git has a version to go back to.", { status: 400 });
      await replaceRoom(env, project, viewer, path, { markdown: file.source, version: file.sha });
      await clearUntyped(env.DB, project.id, viewer.id, path);
      return { intent, discarded: true };
    }
    case "use-own-draft": {
      const own = await readOwnDraft(env.DB, project, viewer, path);
      if (!own) throw new Response("That draft is gone.", { status: 404 });
      await replaceRoom(env, project, viewer, path, { markdown: own.source, version: (await roomVersion(env, project, path)) ?? own.baseVersion, unsaved: true });
      await discardDraft(env.DB, project, viewer, path);
      return { intent: "discard", discarded: true };
    }
    case "drop-own-draft":
      await discardDraft(env.DB, project, viewer, path);
      return { intent: "discard", discarded: true };
    case "check":
      return { intent, findings: await checkDraft(env.DB, project, path, source) };
    case "dismiss": {
      const id = Number(form.get("finding"));
      if (!Number.isInteger(id)) throw new Response("Bad request", { status: 400 });
      await dismissFinding(env.DB, project, viewer, id);
      return { intent, dismissed: id };
    }
    case "use-ai-draft": {
      // The person's decision: the AI draft's text becomes the working copy in the room, to edit and save.
      const id = Number(form.get("draft"));
      if (!Number.isInteger(id)) throw new Response("Bad request", { status: 400 });
      const ai = await readAiDraft(env.DB, project, viewer, path, id);
      await replaceRoom(env, project, viewer, path, { markdown: ai.source, version: (await roomVersion(env, project, path)) ?? ai.baseVersion, unsaved: true });
      // The AI's words were not typed, so they never count toward the day (ruling 6).
      await addUntyped(env.DB, project.id, viewer.id, path, countProseWords(parseFile(ai.source).body));
      return { intent, used: id };
    }
    case "save": {
      const { repo, detail } = bookRepo(env);
      if (!repo) return { intent, outcome: { ok: false, reason: "failed", message: `${detail} The text is kept here in Carrel.` } };
      const untyped = untypedField(form.get("untyped"));
      return {
        intent,
        outcome: await saveRoom(env, project, viewer, path, (text, expectedVersion, others) =>
          saveBookFile(env.DB, repo, project, viewer, path, { source: text, expectedVersion, untyped, shared: others }),
        ),
      };
    }
    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/** A check writes nothing the page shows, so the page has nothing to reload and Git is not asked. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const intent = formData?.get("intent");
  if (intent === "check") return false;
  return defaultShouldRevalidate;
}

export default function BookFileRoute({ loaderData }: Route.ComponentProps) {
  return <BookFile key={`${loaderData.project.slug}/${loaderData.path}`} data={loaderData} />;
}

type Ask = { kind: "discard" | "dismiss" | "use-ai"; id?: number; opener: HTMLElement | null };

function BookFile({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [asking, setAsking] = useState<Ask | null>(null);
  const writer = useFetcher<ActionResult>();
  const checker = useFetcher<ActionResult>();
  const { say } = useMessage();
  useTypingRecede();
  const base = `/b/${data.project.slug}`;

  // The file's room: one copy for everyone on the book, as they type.
  const editing = useRoomEditing({
    path: data.room?.path ?? "",
    initial: data.source,
    unsaved: data.unsaved,
    viewer: data.room?.viewer ?? { id: 0, name: "", role: "reader", access: "suggest" },
    names: data.room?.names ?? {},
    hideFrontMatter: false,
  });
  const { room } = editing;
  const source = data.room ? room.source : data.source;
  const setSource = (next: string) => {
    if (!room.setSource(next).ok) say("Accept or reject the suggestions in that passage first.");
  };
  useEffect(() => {
    if (room.notice) say(room.notice);
  }, [room.notice, say]);
  const readOnly = !data.room;

  // Words this person pasted or dropped into the text and not yet reported: they reach the file but
  // were not typed, so the day's count leaves them out (ruling 6). A save carries the count, and the
  // part it carried comes off once the server has it.
  const untyped = useRef(0);
  const untypedSent = useRef(0);
  const countUntyped = (text: string | undefined) => {
    if (data.canEdit && text) untyped.current += countProseWords(text);
  };

  const outcome = writer.data?.intent === "save" ? writer.data.outcome : null;
  useEffect(() => {
    if (outcome?.ok && writer.state === "idle") untyped.current = Math.max(0, untyped.current - untypedSent.current);
    if (writer.state === "idle") untypedSent.current = 0;
  }, [outcome, writer.state]);
  // A discard or an AI draft taken replaces the text, and what was pasted into it goes with it.
  useEffect(() => {
    if (writer.state === "idle" && (writer.data?.intent === "discard" || writer.data?.intent === "use-ai-draft")) untyped.current = 0;
  }, [writer.state, writer.data]);

  // Said once in the message region, as each save finishes.
  const said = useRef<unknown>(null);
  useEffect(() => {
    if (!outcome?.ok || writer.state !== "idle" || said.current === outcome) return;
    said.current = outcome;
    say(`Saved to Git (${outcome.commit.slice(0, 7)}). ${outcome.findings.length === 0 ? "Nothing flagged." : `${outcome.findings.length} flag${outcome.findings.length === 1 ? "" : "s"}; see the list.`}`);
  }, [outcome, writer.state, say]);

  // Before a save the room is asked to confirm it has every change made here, so the save holds them.
  const send = async (intent: string, extra: Record<string, string> = {}) => {
    await room.flush();
    if (intent === "save") untypedSent.current = untyped.current;
    return writer.submit({ intent, untyped: String(intent === "save" ? untyped.current : 0), ...extra }, { method: "post" });
  };

  useSaveShortcut(() => {
    if (data.canEdit && data.connected && writer.state === "idle") void send("save");
  });

  const busy = writer.state !== "idle";
  const checked = checker.data?.intent === "check" ? checker.data.findings : null;
  const saveState =
    room.status === "offline" ? "Offline: changes wait here" : room.unsaved ? "Changes kept in Carrel, not yet in Git" : data.version ? "Matches Git" : "";
  const openFlags = data.findings.filter((f) => f.status === "open").length;
  const ask = (kind: Ask["kind"], opener: HTMLElement | null, id?: number) => setAsking({ kind, opener, id });

  const crumbs: { label: string; href?: string }[] = [{ label: data.project.name, href: base }];
  if (data.kind === "scene") crumbs.push({ label: titleFromSegment(data.path.split("/")[1]!), href: `${base}/c/${data.path.split("/")[1]}` });
  crumbs.push({ label: data.label });

  return (
    <div className="app-page app-editor">
      <PageHead
        renderLink={RouterLink}
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
            This file changed in Git after this copy was started, so saving it will be refused. Discard the unsaved changes to load Git's version, then make them again.
          </Banner>
        ) : null}
        {data.ownDraft && data.canEdit ? (
          <Banner
            tone="info"
            title="You have a draft of your own from before shared editing"
            actions={
              <>
                <Button size="sm" pending={busy} onClick={() => void send("use-own-draft")}>
                  Put it in for everyone
                </Button>
                <Button size="sm" variant="quiet" pending={busy} onClick={() => void send("drop-own-draft")}>
                  Delete it
                </Button>
              </>
            }
          >
            It was saved <Time at={data.ownDraft.updatedAt} format="exact" />. Putting it in replaces the text everyone here is working on.
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
            {data.room ? editing.bar : null}
            <WritingSurface
              label={data.kind === "scene" ? "Scene" : "File"}
              value={source}
              onChange={setSource}
              readOnly={readOnly}
              linkTargets={[]}
              dialect="plain"
              room={data.room ? { rich: editing.rich, markdownLocked: editing.markdownLocked } : undefined}
              onEditor={editing.setEditor}
            />
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
                  <Button variant="primary" pending={busy} disabledReason={!data.connected ? "Git is not connected, so saving waits. The text is kept here in Carrel." : undefined} onClick={() => void send("save")}>
                    Save to Git
                  </Button>
                  <Button pending={checker.state !== "idle"} onClick={() => checker.submit({ intent: "check", source }, { method: "post" })}>
                    Check this text
                  </Button>
                  {room.unsaved && data.version ? (
                    <Button variant="quiet" pending={busy} onClick={(event) => ask("discard", event.currentTarget)}>
                      Discard unsaved changes
                    </Button>
                  ) : null}
                </div>
              </div>
            </Panel>
          ) : null}

          {data.room ? editing.panels : null}

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
            <Panel title="AI drafts beside yours" count={data.aiDrafts.length} src="None has touched the text or Git">
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
                          Use as the working copy
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
        title="Discard the unsaved changes?"
        lead="The text goes back to Git's version for everyone working on it, and every change since the last save is lost, suggestions too. This cannot be undone."
        body={[]}
        action="Discard unsaved changes"
        returnTo={asking?.opener}
        perform={async () => void (await send("discard"))}
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
        title="Use the AI draft as the working copy?"
        lead="Its text replaces the text everyone here is working on, which you then edit and save as usual. Changes since the last save are not kept."
        body={[]}
        action="Replace the text"
        returnTo={asking?.opener}
        perform={async () => {
          if (asking?.id !== undefined) await writer.submit({ intent: "use-ai-draft", draft: String(asking.id) }, { method: "post" });
        }}
        onClose={() => setAsking(null)}
      />
    </div>
  );
}
