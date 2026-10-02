// The editor for one site item: the copied CodeMirror editor in a prose layout, autosave to D1 as
// you type, the site's own render in a sandboxed preview, and the writes the viewer's role allows.

import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { PublishGate, type GateCheck, type GateSite } from "capsomer/react/publish-gate";
import { Segmented } from "capsomer/react/segmented";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { WritingSurface } from "~/components/editor/writing-surface";
import { useTypingRecede } from "~/components/editor/typing";
import { PageHead } from "~/components/page-head";
import { dismissItemFinding, itemFindings, lastAiPublication, listAiDrafts, publishedByLine } from "~/lib/ai.server";
import { autosave, discardDraft, readDoc, readDraft, writeToSite, type WriteOutcome } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { importFromDocs, lastSentDoc, sendToDocs } from "~/lib/google/drive.server";
import { isConnected } from "~/lib/google/oauth.server";
import { pageStats } from "~/lib/google/search-console.server";
import { GoogleNotConnected } from "~/lib/google/service-account.server";
import { searchItems } from "~/lib/index.server";
import { mediaLimits } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { transitionsFor } from "~/lib/publish-transition.mjs";
import { can } from "~/lib/roles";
import { figureMarkup } from "~/lib/site-markdown";
import { siteConnection, siteEntry, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/editor";

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

  const [targets, flags, aiDrafts, aiPublished, sentDoc, googleConnected, search] = await Promise.all([
    searchItems(env.DB, project.id, {}),
    itemFindings(env.DB, project, itemId),
    listAiDrafts(env.DB, project, viewer, itemId),
    lastAiPublication(env.DB, project, itemId),
    lastSentDoc(env.DB, project, itemId),
    can(project.role, "send_external") ? isConnected(env.DB, viewer) : Promise.resolve(false),
    pageStats(env, project, doc?.path ?? null),
  ]);
  // Images go in only for someone who may edit, and only on a site with a media library. A site that
  // does not answer leaves the editor without them rather than failing the page.
  let mediaAccept: string | null = null;
  if (can(project.role, "edit") && !siteError) {
    try {
      mediaAccept = (await mediaLimits(env, project))?.types.join(",") ?? null;
    } catch {
      mediaAccept = null;
    }
  }
  const linkTargets: { slug: string; title: string; state: "published" | "scheduled" | "draft" }[] = targets
    .filter((t) => t.itemId !== itemId)
    .map((t) => ({ slug: t.itemId, title: t.title || t.itemId, state: t.status }));

  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name, siteId: project.site },
    itemId,
    canEdit: can(project.role, "edit"),
    media: mediaAccept ? { endpoint: `/p/${encodeURIComponent(project.slug)}/media/api`, accept: mediaAccept } : null,
    canPublish: can(project.role, "publish"),
    title: doc?.title ?? "",
    status: doc?.status ?? null,
    path: doc?.path ?? null,
    everPublished: Boolean(doc?.publishedAt),
    publishedAt: doc?.publishedAt ?? null,
    // Where the post lives, for the publish controls' View link: the site's origin and the post's path.
    liveUrl: doc?.path && siteConnection(env, project.site).state === "connected" ? new URL(doc.path, (siteConnection(env, project.site) as { origin: string }).origin).href : null,
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
    canSend: can(project.role, "send_external"),
    googleConnected,
    sentDoc: sentDoc ? { url: sentDoc.url, at: sentDoc.createdAt } : null,
    search: search
      ? { clicks: search.clicks, impressions: search.impressions, position: Math.round(search.position * 10) / 10, start: search.startDate, end: search.endDate }
      : null,
  };
}

type ActionResult =
  | { intent: "autosave"; updatedAt: string }
  | { intent: "discard"; discarded: true }
  | { intent: "publish"; needsConfirm: true }
  | { intent: "dismiss-flag"; dismissed: number }
  | { intent: "write"; outcome: WriteOutcome }
  | { intent: "google"; ok: boolean; message: string; url?: string; imported?: boolean };

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
    case "send-to-docs":
    case "import-from-docs": {
      try {
        if (intent === "send-to-docs") {
          const sent = await sendToDocs(env, project, viewer, itemId);
          return sent.ok ? { intent: "google", ok: true, message: "Sent to Google Docs.", url: sent.url } : { intent: "google", ok: false, message: sent.message };
        }
        const imported = await importFromDocs(env, project, viewer, itemId);
        return imported.ok
          ? { intent: "google", ok: true, imported: true, message: `Imported ${imported.words} words from Google Docs as your draft.` }
          : { intent: "google", ok: false, message: imported.message };
      } catch (error) {
        if (error instanceof GoogleNotConnected) return { intent: "google", ok: false, message: error.detail };
        throw error;
      }
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

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function Editor({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const [source, setSource] = useState(data.source);
  const [savedSource, setSavedSource] = useState(data.source);
  const [savedAt, setSavedAt] = useState<string | null>(data.draftAt);
  const [layout, setLayout] = useState<Layout>("write");
  const [scheduleAt, setScheduleAt] = useState("");
  const [asking, setAsking] = useState<null | { kind: "discard" | "import" | "schedule" | "dismiss"; flag?: number; opener: HTMLElement | null }>(null);
  const autosaver = useFetcher<ActionResult>();
  const writer = useFetcher<ActionResult>();
  const { say } = useMessage();
  useTypingRecede();

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

  // After an import, the loader has the imported draft, which replaces the local copy.
  const imported = writer.data?.intent === "google" && writer.data.imported === true && writer.state === "idle";
  useEffect(() => {
    if (imported) {
      setSource(data.source);
      setSavedSource(data.source);
      setSavedAt(data.draftAt);
    }
  }, [imported, data.source, data.draftAt]);

  // A write that reached the site clears the draft there, so the local copy counts as saved.
  const outcome = writer.data?.intent === "write" ? writer.data.outcome : null;
  useEffect(() => {
    if (outcome?.ok && writer.state === "idle") {
      setSavedSource(source);
      setSavedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, writer.state]);

  // What the controls send is read at the moment they send it: the publish controls keep an Undo that
  // runs later, and it must carry the version the site has then, not the one this render saw.
  const latest = useRef({ source, version: data.baseVersion });
  latest.current = { source, version: data.baseVersion };
  const waiting = useRef<((result: ActionResult) => void) | null>(null);
  const viaGate = useRef(false);
  const send = (intent: string, extra: Record<string, string> = {}) =>
    new Promise<ActionResult>((resolve) => {
      waiting.current = resolve;
      writer.submit({ intent, source: latest.current.source, expectedVersion: latest.current.version ?? "", ...extra }, { method: "post" });
    });
  useEffect(() => {
    if (writer.state === "idle" && writer.data && waiting.current) {
      const done = waiting.current;
      waiting.current = null;
      done(writer.data);
    }
  }, [writer.state, writer.data]);

  // The publish controls' two verbs. A rejection carries the site's own words, which the gate says.
  const writeThrough = async (intent: string, extra: Record<string, string> = {}) => {
    viaGate.current = true;
    const result = await send(intent, extra);
    viaGate.current = false;
    if (result.intent !== "write") throw new Error("The site did not answer.");
    if (!result.outcome.ok) throw new Error(result.outcome.message);
  };

  // Results of the buttons Carrel owns are said in the message region; the gate says its own.
  const said = useRef<unknown>(null);
  useEffect(() => {
    if (writer.state !== "idle" || !outcome || said.current === outcome || viaGate.current) return;
    said.current = outcome;
    if (outcome.ok) say(outcome.action === "save" ? "Saved to the site." : outcome.action === "schedule" ? "Scheduled." : outcome.action === "publish" ? "Published." : "Returned to draft.");
  }, [outcome, writer.state, say]);

  // Cmd+S saves in place: a draft stays a draft, a live post is updated.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (maySave && writer.state === "idle") void send("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const busy = writer.state !== "idle";
  const transitions = data.status ? transitionsFor(data.status === "draft" ? "draft" : "published", data.everPublished) : [];
  const saveTransition = transitions.find((t) => t.id === "save-draft" || t.id === "save");
  const saveState =
    autosaver.state !== "idle" ? "Saving to Carrel" : source !== savedSource ? "Not yet saved" : savedAt ? `Draft saved in Carrel ${new Date(savedAt).toLocaleTimeString()}` : onSite ? "Matches the site" : "";
  // Absolute, not relative: from /p/x/e/item a bare "preview" would resolve to /p/x/e/preview.
  const previewSrc = `/p/${encodeURIComponent(data.project.slug)}/e/${encodeURIComponent(data.itemId)}/preview?at=${encodeURIComponent(savedAt ?? data.version ?? "")}`;
  const failure = outcome && !outcome.ok && !viaGate.current ? outcome : null;
  const google = writer.data?.intent === "google" && !busy ? writer.data : null;

  const gateSite: GateSite = {
    id: data.project.siteId,
    name: data.project.site,
    first: !data.everPublished,
    published: data.status === "published" && data.liveUrl ? { at: data.publishedAt ?? "", url: data.liveUrl } : null,
    hold: data.status === "scheduled" && data.publishAt ? { reason: "scheduled", untilLabel: utc(data.publishAt), text: `Scheduled for ${utc(data.publishAt)}` } : null,
  };
  // Open flags never stop a publish here (checks and reviewers flag, they do not decide), so each is advisory.
  const gateChecks: GateCheck[] = data.flags.map((f) => ({
    id: `flag-${f.id}`,
    name: "Flag",
    required: false,
    ok: f.status !== "open",
    cause: f.message,
    pass: "Dismissed",
    href: "#flags",
    fix: "Change the text, or dismiss the flag.",
  }));

  const ask = (kind: "discard" | "import" | "schedule" | "dismiss", opener: HTMLElement | null, flag?: number) => setAsking({ kind, opener, flag });

  return (
    <div className="app-page app-editor" data-layout={layout}>
      <PageHead
        crumbs={[{ label: data.project.name, href: `/p/${data.project.slug}` }, { label: "Post" }]}
        title={data.title || data.itemId}
        lead={
          <>
            {data.status === "published" ? <Pill tone="ok">Published</Pill> : data.status === "scheduled" ? <Pill tone="info">Scheduled</Pill> : data.status === "draft" ? <Pill variant="secondary">Draft</Pill> : <Pill variant="outline">Not on the site yet</Pill>}{" "}
            {data.path ? <span className="cap-mono">{data.path}</span> : null}
          </>
        }
        actions={<Segmented legend="Layout" hideLegend size="sm" value={layout} onChange={chooseLayout} options={[{ value: "write", label: "Write" }, { value: "split", label: "Split" }, { value: "preview", label: "Preview" }]} />}
      />

      <div className="app-notices">
        {data.siteError ? <Banner tone="warn">{data.siteError}</Banner> : null}
        {data.behind ? (
          <Banner tone="warn" title="The site's copy changed">
            It changed after this draft was started, so saving it will be refused. Discard the draft to load the site's version, then reapply your changes.
          </Banner>
        ) : null}
        {data.aiPublished && data.status === "published" ? (
          <Banner tone="info">
            {data.aiPublished.line} <Time at={data.aiPublished.at} format="exact" />
          </Banner>
        ) : null}
        {data.canEdit && live && !data.canPublish ? <Banner tone="info">This post is live. Your changes autosave here as your draft; sending them to the site is the Owner's step.</Banner> : null}
      </div>

      <div className="app-editor-grid">
        <div className="app-editor-main">
          <div className="app-editor-body" data-layout={layout}>
            {layout !== "preview" ? (
              <section className="app-editor-pane" aria-label="Write">
                <WritingSurface
                  label="Post"
                  value={source}
                  onChange={setSource}
                  readOnly={readOnly}
                  linkTargets={data.linkTargets.map((t) => ({ href: `/blog/${t.slug}`, title: t.title, hint: `/blog/${t.slug}`, note: t.state !== "published" ? `not live yet (${t.state})` : undefined }))}
                  media={data.media ? { ...data.media, figure: (url: string, alt: string) => figureMarkup(data.project.siteId, url, alt) } : null}
                />
              </section>
            ) : null}
            {layout !== "write" ? (
              <section className="app-preview-pane" aria-label="Preview">
                {/* Sandboxed with no permissions: the site's page runs no script and has an opaque origin. */}
                <iframe title={`Preview of ${data.title || data.itemId} as ${data.project.site} renders it`} src={previewSrc} sandbox="" />
              </section>
            ) : null}
          </div>
          {data.flags.length > 0 || data.aiDrafts.length > 0 ? (
            <Panel title="Flags and AI drafts" id="flags" count={openFlags} src={`${data.aiDrafts.length} AI draft${data.aiDrafts.length === 1 ? "" : "s"} beside yours`}>
              <div className="app-stack" data-tight>
                {data.flags.length > 0 ? (
                  <ul className="app-flags" aria-label="Flags">
                    {data.flags.map((f) => (
                      <li key={f.id}>
                        {f.status === "open" ? <Status tone="warn">Open</Status> : <Pill variant="secondary">Dismissed</Pill>}
                        <span>
                          {f.message}
                          {f.excerpt ? (
                            <>
                              {" "}
                              <q className="cap-muted">{f.excerpt}</q>
                            </>
                          ) : null}
                        </span>
                        {f.status === "open" && data.canPublish ? (
                          <Button size="sm" onClick={(event) => ask("dismiss", event.currentTarget, f.id)}>
                            Dismiss<span className="cap-sr-only"> flag: {f.message}</span>
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {data.aiDrafts.length > 0 ? (
                  <ul className="app-flags" aria-label="AI drafts beside yours">
                    {data.aiDrafts.map((d) => (
                      <li key={d.id}>
                        <span>
                          <Link to={`ai/${d.id}`}>AI draft from {d.client}</Link>{" "}
                          <span className="cap-muted">
                            <Time at={d.createdAt} /> · {d.words} words
                          </span>
                          {d.note ? <span> · {d.note}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                            </div>
            </Panel>
          ) : null}
        </div>

        <aside className="app-editor-side" aria-label="Saving and publishing">
          {data.canEdit ? (
            <Panel title="This draft" src={data.version ? "On the site" : "Only in Carrel so far"}>
              <div className="app-stack" data-tight>
                <p role="status" className="app-savestate">
                  {saveState}
                </p>
                {failure ? <Alert tone="crit">{failure.message}</Alert> : null}
                {google ? (
                  google.ok ? (
                    <Banner tone="ok">
                      {google.message}{" "}
                      {google.url ? (
                        <a href={google.url} target="_blank" rel="noreferrer">
                          Open the Doc<span className="cap-sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                    </Banner>
                  ) : (
                    <Alert tone="crit">{google.message}</Alert>
                  )
                ) : null}
                <div className="app-actions">
                  {!onSite && maySave ? (
                    <Button variant="primary" pending={busy} onClick={() => void send("save")}>
                      Save draft to the site
                    </Button>
                  ) : null}
                  {onSite && maySave && saveTransition ? (
                    <Button variant={data.status === "draft" ? "default" : "primary"} pending={busy} onClick={() => void send("save")}>
                      {saveTransition.label}
                    </Button>
                  ) : null}
                  {onSite && data.canPublish && data.status === "scheduled" ? (
                    <Button pending={busy} onClick={() => void send("unpublish")}>
                      Revert to draft
                    </Button>
                  ) : null}
                  {onSite && data.canPublish && data.status !== "published" ? (
                    <Button onClick={(event) => ask("schedule", event.currentTarget)}>Schedule</Button>
                  ) : null}
                  {savedAt ? (
                    <Button variant="quiet" pending={busy} onClick={(event) => ask("discard", event.currentTarget)}>
                      Discard my draft
                    </Button>
                  ) : null}
                </div>
                {data.canSend && data.googleConnected ? (
                  <div className="app-actions">
                    <Button variant="quiet" pending={busy} onClick={() => void send("send-to-docs")}>
                      Send to Google Docs
                    </Button>
                    {data.sentDoc ? (
                      <Button variant="quiet" pending={busy} onClick={(event) => ask("import", event.currentTarget)}>
                        Import from Docs
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Panel>
          ) : null}

          {onSite && data.canPublish ? (
            <PublishGate
              label="Publish checks"
              sites={[gateSite]}
              checks={gateChecks}
              publish={() => writeThrough("publish", { confirm: "first-publish" })}
              unpublish={() => writeThrough("unpublish")}
              say={say}
              fail={(text) => say(text)}
            />
          ) : null}

          {data.search ? (
            <Panel title="Search" src={`${data.search.start} to ${data.search.end}`} size="sm">
              <dl className="app-facts">
                <dt>Clicks</dt>
                <dd className="cap-num">{data.search.clicks}</dd>
                <dt>Impressions</dt>
                <dd className="cap-num">{data.search.impressions}</dd>
                <dt>Position</dt>
                <dd className="cap-num">{data.search.position}</dd>
              </dl>
            </Panel>
          ) : null}
        </aside>
      </div>

      <ConfirmDialog
        open={asking?.kind === "discard"}
        title="Discard your draft?"
        lead="Your working copy in Carrel is deleted, and the editor goes back to the site's text. This cannot be undone."
        body={[]}
        action="Discard my draft"
        returnTo={asking?.opener}
        perform={async () => void (await send("discard"))}
        onClose={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.kind === "import"}
        title="Import from Google Docs?"
        lead="The Doc's text replaces your working draft. This cannot be undone."
        body={[]}
        action="Import and replace"
        returnTo={asking?.opener}
        perform={async () => void (await send("import-from-docs"))}
        onClose={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.kind === "dismiss"}
        title="Dismiss this flag?"
        lead="A dismissed flag no longer holds publish, and it cannot be reopened."
        body={asking?.flag !== undefined ? [data.flags.find((f) => f.id === asking.flag)?.message ?? ""] : []}
        action="Dismiss flag"
        returnTo={asking?.opener}
        perform={async () => {
          if (asking?.flag !== undefined) await writer.submit({ intent: "dismiss-flag", flag: String(asking.flag) }, { method: "post" });
        }}
        onClose={() => setAsking(null)}
      />
      <Dialog open={asking?.kind === "schedule"} onOpenChange={(o) => !o && setAsking(null)} placement="center" size="sm" returnTo={asking?.opener} aria-labelledby="schedule-title">
        <DialogHeader divider>
          <DialogTitle id="schedule-title">Schedule this post</DialogTitle>
          <DialogDescription>The site publishes it at the time you choose. Revert to draft takes it back.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Publish at" required>
            <input className="cap-input" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter align="between">
          <DialogClose part="cancel">Cancel</DialogClose>
          <Button
            variant="primary"
            disabledReason={!scheduleAt ? "Choose a time first." : undefined}
            onClick={async () => {
              await send("schedule", { publishAt: new Date(scheduleAt).toISOString() });
              setAsking(null);
            }}
          >
            Schedule
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
