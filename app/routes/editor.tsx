// The editor for one site item: the formatted editor (or Markdown) in a prose layout, in the item's
// live room, where everyone on the project works on one copy at once (ruling point 3, build step 10),
// with comments and suggestions; the site's own render in a sandboxed preview; and the writes the
// viewer's role allows, each sending the room's text through site-api's version check.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFetcher } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { PublishGate, type GateCheck, type GateSite } from "capsomer/react/publish-gate";
import { Segmented } from "capsomer/react/segmented";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { exact, parse } from "capsomer/behavior/time";

import { FlagsPanel } from "~/components/editor/flags-panel";
import { useEditorLayout } from "~/components/editor/layout";
import { ScheduleDialog } from "~/components/editor/schedule-dialog";
import { FrontmatterFields } from "~/components/editor/frontmatter-fields";
import { SearchSharingPanel } from "~/components/editor/search-sharing";
import { useRoomEditing } from "~/components/editor/room-editing";
import { useSaveShortcut } from "~/components/editor/save-keys";
import { HistoryPanel } from "~/components/history/history-panel";
import { WritingSurface } from "~/components/editor/writing-surface";
import { useTypingRecede } from "~/components/editor/typing";
import { RouterLink } from "~/components/frame";
import { SiteBinder } from "~/components/writing/binder";
import { dismissItemFinding, itemFindings, lastAiPublication, listAiDrafts, publishedByLine } from "~/lib/ai.server";
import { roomNames } from "~/lib/comments.server";
import { discardDraft, mayPublishItem, readDoc, readDraft, readOwnDraft, writeToSite, type WriteOutcome } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { listRevisions } from "~/lib/history.server";
import { joinSource, splitSource } from "@dustinedwards/site-api/frontmatter";
import { listSections } from "~/lib/legal.server";
import { kindNoun, kindWord } from "~/lib/kind-words";
import { siteState } from "~/lib/save-state";
import { importFromDocs, lastSentDoc, sendToDocs } from "~/lib/google/drive.server";
import { isConnected } from "~/lib/google/oauth.server";
import { pageStats } from "~/lib/google/search-console.server";
import { GoogleNotConnected } from "~/lib/google/service-account.server";
import { searchItems, sitePaths } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { transitionsFor } from "capsomer/publish-transition";
import { PageHead } from "capsomer/react/page-head";
import type { RoomViewer } from "~/lib/editor/room-protocol";
import { can } from "~/lib/roles";
import { openRoom, rebaseRoom, replaceRoom, roomPath, roomVersion, saveRoom, siteCoauthors, withOthers } from "~/lib/rooms.server";
import { seoCheck } from "~/lib/seo-checks";
import { figureMarkup } from "~/lib/site-markdown";
import { siteClient, siteConnection, siteEntry, SiteNotConnected } from "~/lib/sites.server";
import { siteBinderTree } from "~/lib/writing/binder";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/editor";

/** The editor shows the newest revisions; the history page lists them all. */
const HISTORY_SHOWN = 8;

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.title || data.itemId} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const itemId = params.item;

  let doc = null;
  let siteError: string | null = null;
  try {
    doc = await readDoc(env, project, itemId);
  } catch (error) {
    siteError = error instanceof SiteNotConnected ? error.detail : "The site did not answer, so this shows your Carrel draft only.";
  }
  // An item that exists only as an AI draft is still the person's to open: the list shows it.
  const aiDrafts = await listAiDrafts(env.DB, project, viewer, itemId);
  if (!doc && !siteError && aiDrafts.length === 0 && !(await readDraft(env.DB, project, viewer, itemId))) throw new Response("Not found", { status: 404 });
  // Everyone on the item works in its room. A site that did not answer leaves a room not started yet
  // unstarted, and the page read only.
  const opened = await openRoom(env, project, viewer, itemId, {
    dialect: "site",
    current: doc ? { source: doc.source, version: doc.version } : null,
    unknown: Boolean(siteError),
  });
  const roomViewer: RoomViewer = { id: viewer.id, name: viewer.name || viewer.email, role: project.role, access: can(project.role, "edit") ? "edit" : "suggest" };

  // The site's revisions of this item, for the History panel. A site that does not answer leaves the
  // panel saying so, never the editor failing.
  let revisions: Awaited<ReturnType<typeof listRevisions>> = null;
  let historyError: string | null = null;
  if (doc) {
    try {
      revisions = await listRevisions(env, project, itemId);
    } catch (error) {
      historyError = error instanceof SiteNotConnected ? error.detail : "The site did not answer, so its history is not shown.";
    }
  }

  const [targets, flags, aiPublished, sentDoc, googleConnected, search, sections, canPublish] = await Promise.all([
    searchItems(env.DB, project.id, {}),
    itemFindings(env.DB, project, itemId),
    lastAiPublication(env.DB, project, itemId),
    lastSentDoc(env.DB, project, itemId),
    can(project.role, "send_external") ? isConnected(env.DB, viewer) : Promise.resolve(false),
    pageStats(env, project, doc?.path ?? null),
    listSections(env.DB),
    // The Owner publishes any post; an Author only one they wrote (roles.ts).
    mayPublishItem(env.DB, project, viewer, itemId),
  ]);
  // Images go in only for someone who may edit, and only on a site with a media library; scheduling an
  // update to a live post only on a site that keeps it live meanwhile. A site that does not answer
  // leaves the editor without them rather than failing the page.
  let mediaAccept: string | null = null;
  let scheduledUpdates = false;
  // The text of an update waiting on the live post, so its Author or the Owner can open it again.
  let pendingUpdate: { publishAt: string; source: string } | null = null;
  if (doc?.scheduledUpdate) {
    // 404 when none waits after all, 501 on a site without the capability: either way no text.
    const waiting = await Promise.resolve()
      .then(() => siteClient(env, project.site).scheduledUpdate(itemId))
      .catch(() => null);
    pendingUpdate = { publishAt: doc.scheduledUpdate.publishAt, source: waiting?.source ?? "" };
  }
  if ((can(project.role, "edit") || canPublish) && !siteError) {
    try {
      const { capabilities } = await siteClient(env, project.site).meta();
      mediaAccept = can(project.role, "edit") && capabilities.media ? (capabilities.mediaUpload?.types.join(",") ?? null) : null;
      scheduledUpdates = capabilities.scheduledUpdates === true;
    } catch {
      mediaAccept = null;
    }
  }
  const coauthors = revisions ? await siteCoauthors(env.DB, project.id, itemId) : new Map<string, string[]>();
  const paths = sitePaths(targets);
  const connection = siteConnection(env, project.site);
  const linkTargets: { href: string; title: string; state: "published" | "scheduled" | "draft" }[] = targets
    .filter((t) => t.itemId !== itemId && paths.has(t.itemId))
    .map((t) => ({ href: paths.get(t.itemId)!, title: t.title || t.itemId, state: t.status }));

  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name, siteId: project.site },
    itemId,
    binder: siteBinderTree(targets, `/p/${project.slug}`),
    canEdit: can(project.role, "edit") && opened !== null,
    media: mediaAccept ? { endpoint: `/p/${encodeURIComponent(project.slug)}/media/api`, accept: mediaAccept } : null,
    canPublish,
    // Dismissing a flag clears it for publish on any post, so it stays the Owner's.
    canDismiss: can(project.role, "publish"),
    scheduledUpdates,
    pendingUpdate,
    title: doc?.title ?? "",
    kind: doc?.kind ?? null,
    status: doc?.status ?? null,
    path: doc?.path ?? null,
    everPublished: Boolean(doc?.publishedAt),
    publishedAt: doc?.publishedAt ?? null,
    // Where the post lives, for the publish controls' View link: the site's origin and the post's path.
    liveUrl: doc?.path && connection.state === "connected" ? new URL(doc.path, connection.origin).href : null,
    // For the search and sharing preview: the site's origin, and the post's address, or the one its published siblings show.
    origin: connection.state === "connected" ? connection.origin : null,
    address: doc?.path ?? paths.get(itemId) ?? null,
    publishAt: doc?.publishAt ?? null,
    version: doc?.version ?? null,
    source: opened?.source ?? doc?.source ?? "",
    baseVersion: opened ? opened.version : (doc?.version ?? null),
    // The room's changes nobody has saved, and the person's own draft from before the room.
    unsaved: opened?.unsaved ?? false,
    ownDraft: opened?.ownDraft ?? null,
    // The site moved on since the room's copy was started: saving it would be refused as stale.
    behind: opened?.behind ?? false,
    room: opened ? { path: roomPath("p", project.slug, itemId), viewer: roomViewer, names: await roomNames(env.DB, project.id) } : null,
    siteError,
    revisions: revisions ? revisions.slice(0, HISTORY_SHOWN).map((r) => ({ version: r.version, at: r.at, author: withOthers(r.author, coauthors.get(r.version)), message: r.message })) : null,
    revisionCount: revisions?.length ?? 0,
    historyError,
    linkTargets,
    sections: sections.map((s) => ({ key: s.key, title: s.title })),
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
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  // Every write sends the room's text at that moment, checked against the room's version.
  const fromRoom = (write: (source: string, expectedVersion: string | null) => Promise<WriteOutcome>) => saveRoom(env, project, viewer, itemId, write);
  const onSiteVersion = (version: string | null) => {
    if (!version) throw new Response("Save the post to the site first.", { status: 400 });
    return version;
  };
  /** A write with no text, then the room takes the site's new version if nothing else changed. */
  const withoutText = async (action: "unschedule" | "unpublish") => {
    const version = await roomVersion(env, project, itemId);
    if (!version) throw new Response(action === "unpublish" ? "Only a post on the site can be unpublished." : "Only a post on the site has a scheduled update.", { status: 400 });
    const outcome = await writeToSite(env, project, viewer, itemId, { action, expectedVersion: version });
    const now = outcome.ok ? await readDoc(env, project, itemId) : null;
    if (now) await rebaseRoom(env, project, itemId, { version: now.version, source: now.source });
    return outcome;
  };

  switch (intent) {
    case "discard": {
      // Everyone in the room goes back to the site's text.
      const current = await readDoc(env, project, itemId);
      if (!current) throw new Response("Only a post on the site has a version to go back to.", { status: 400 });
      await replaceRoom(env, project, viewer, itemId, { markdown: current.source, version: current.version });
      return { intent, discarded: true };
    }
    case "use-own-draft": {
      // The person's own draft from before live editing, put in the room for everyone.
      const own = await readOwnDraft(env.DB, project, viewer, itemId);
      if (!own) throw new Response("That draft is gone.", { status: 404 });
      await replaceRoom(env, project, viewer, itemId, { markdown: own.source, version: (await roomVersion(env, project, itemId)) ?? own.baseVersion, unsaved: true });
      await discardDraft(env.DB, project, viewer, itemId);
      return { intent: "discard", discarded: true };
    }
    case "drop-own-draft":
      await discardDraft(env.DB, project, viewer, itemId);
      return { intent: "discard", discarded: true };
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
      return { intent: "write", outcome: await fromRoom((source, expectedVersion) => writeToSite(env, project, viewer, itemId, { action: "save", source, expectedVersion })) };
    case "publish": {
      // Refused before the ceremony, so a person who may not publish is never asked to confirm.
      if (!(await mayPublishItem(env.DB, project, viewer, itemId))) throw new Response("Forbidden", { status: 403 });
      if (!(await roomVersion(env, project, itemId))) throw new Response("Save the post to the site before publishing it.", { status: 400 });
      const current = await readDoc(env, project, itemId);
      // The site's ceremony, kept: a post that has never been public is published only on a second, explicit ask.
      if (current && !current.publishedAt && form.get("confirm") !== "first-publish") return { intent, needsConfirm: true };
      return { intent: "write", outcome: await fromRoom((source, expectedVersion) => writeToSite(env, project, viewer, itemId, { action: "publish", source, expectedVersion: onSiteVersion(expectedVersion) })) };
    }
    case "schedule": {
      const publishAt = String(form.get("publishAt") ?? "");
      if (!(await roomVersion(env, project, itemId)) || Number.isNaN(Date.parse(publishAt))) throw new Response("A schedule needs a saved post and a time.", { status: 400 });
      return {
        intent: "write",
        outcome: await fromRoom((source, expectedVersion) =>
          writeToSite(env, project, viewer, itemId, { action: "schedule", source, expectedVersion: onSiteVersion(expectedVersion), publishAt: new Date(publishAt).toISOString() }),
        ),
      };
    }
    case "unschedule":
    case "unpublish":
      return { intent: "write", outcome: await withoutText(intent) };
    default:
      throw new Response("Bad request", { status: 400 });
  }
}

export default function EditorRoute({ loaderData }: Route.ComponentProps) {
  // A new item gets a fresh editor, not the last item's cursor and history.
  return <Editor key={`${loaderData.project.slug}/${loaderData.itemId}`} data={loaderData} />;
}

const noSubscribe = () => () => {};
/** False on the server and in the render that hydrates, true after: a time in a string prop is in UTC until then, as Capsomer's Time draws one. */
function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

function Editor({ data }: { data: Route.ComponentProps["loaderData"] }) {
  const hydrated = useHydrated();
  const exactTime = (iso: string) => exact(parse(iso), hydrated ? undefined : "UTC");
  const [layout, chooseLayout] = useEditorLayout();
  const [asking, setAsking] = useState<null | { kind: "discard" | "import" | "schedule" | "dismiss" | "save-live" | "unschedule"; flag?: number; opener: HTMLElement | null }>(null);
  const writer = useFetcher<ActionResult>();
  const { say } = useMessage();
  useTypingRecede();

  // The item's room: one copy for everyone on the project, as they type.
  const editing = useRoomEditing({
    path: data.room?.path ?? "",
    initial: data.source,
    unsaved: data.unsaved,
    viewer: data.room?.viewer ?? { id: 0, name: "", role: "reader", access: "suggest" },
    names: data.room?.names ?? {},
    hideFrontMatter: true,
  });
  const { room } = editing;
  const source = data.room ? room.source : data.source;
  const setSource = (next: string) => {
    const patched = room.setSource(next);
    if (!patched.ok) say("Accept or reject the suggestions in that passage first.");
  };
  useEffect(() => {
    if (room.notice) say(room.notice);
  }, [room.notice, say]);

  // Reading only: no room (the site did not answer), or a role that suggests, whose changes the room marks.
  const readOnly = !data.room;
  const mayEdit = data.canEdit;
  const live = data.status === "published" || data.status === "scheduled";
  const onSite = data.version !== null;
  // Changes to a live post change the public site, which is the Owner's to do, or the Author's on their own post.
  const maySave = data.canEdit && (!live || data.canPublish);

  const outcome = writer.data?.intent === "write" ? writer.data.outcome : null;

  // The preview reads the room's copy, which the room keeps a second behind the typing.
  const [previewAt, setPreviewAt] = useState(data.baseVersion ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewAt(String(source.length) + ":" + Date.now().toString(36)), 2000);
    return () => window.clearTimeout(timer);
  }, [source]);

  const waiting = useRef<((result: ActionResult) => void) | null>(null);
  const viaGate = useRef(false);
  // Before a write the room is asked to confirm it has every change made here, so the save holds them.
  const send = async (intent: string, extra: Record<string, string> = {}) => {
    await room.flush();
    return new Promise<ActionResult>((resolve) => {
      waiting.current = resolve;
      void writer.submit({ intent, ...extra }, { method: "post" });
    });
  };
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
    if (outcome.ok)
      say(
        outcome.action === "save"
          ? "Saved to the site."
          : outcome.action === "schedule"
            ? outcome.status === "published"
              ? "Update scheduled. The live post stays as it is until then."
              : "Scheduled."
            : outcome.action === "unschedule"
              ? "Scheduled update canceled. The live post is unchanged."
              : outcome.action === "publish"
                ? "Published."
                : "Returned to draft.",
      );
  }, [outcome, writer.state, say]);

  // Cmd+S saves in place: a draft stays a draft, a live post is updated.
  useSaveShortcut(() => {
    if (maySave && writer.state === "idle") saveToSite(null);
  });

  const busy = writer.state !== "idle";
  const transitions = data.status ? transitionsFor(data.status === "draft" ? "draft" : "published", data.everPublished) : [];
  const saveTransition = transitions.find((t) => t.id === "save-draft" || t.id === "save");
  const saveState =
    room.status === "offline"
      ? "Offline: changes wait here"
      : room.unsaved
        ? onSite
          ? "Changes kept in Carrel, not yet on the site"
          : "Kept in Carrel, not yet on the site"
        : onSite
          ? siteState(data.status, data.everPublished)
          : "";
  // Absolute, not relative: from /p/x/e/item a bare "preview" would resolve to /p/x/e/preview.
  const previewSrc = `/p/${encodeURIComponent(data.project.slug)}/e/${encodeURIComponent(data.itemId)}/preview?at=${encodeURIComponent(previewAt)}`;
  const failure = outcome && !outcome.ok && !viaGate.current ? outcome : null;
  const google = writer.data?.intent === "google" && !busy ? writer.data : null;

  const gateSite: GateSite = {
    id: data.project.siteId,
    name: data.project.site,
    first: !data.everPublished,
    published: data.status === "published" && data.liveUrl ? { at: data.publishedAt ?? "", url: data.liveUrl } : null,
    hold: data.status === "scheduled" && data.publishAt ? { reason: "scheduled", untilLabel: exactTime(data.publishAt), text: `Scheduled for ${exactTime(data.publishAt)}` } : null,
  };
  // The search and sharing checks, on the text as it is typed (none for a legal page or another kind).
  const seo = useMemo(() => seoCheck(data.project.siteId, source, { kind: data.kind, origin: data.origin, path: data.address }), [source, data.kind, data.project.siteId, data.origin, data.address]);
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
  // The search and sharing checks are advisory too: the gate names each and points to the panel.
  for (const [i, f] of (seo?.findings ?? []).entries()) {
    gateChecks.push({ id: `seo-${i}`, name: "Search and sharing", required: false, ok: false, cause: f.message, pass: "Fits", href: "#seo", fix: "Change the post's details or the image." });
  }

  const historyPath = `/p/${encodeURIComponent(data.project.slug)}/e/${encodeURIComponent(data.itemId)}/history`;
  const ask = (kind: "discard" | "import" | "schedule" | "dismiss" | "save-live" | "unschedule", opener: HTMLElement | null, flag?: number) => setAsking({ kind, opener, flag });
  // A save to a live post with an update waiting changes the live post now, and the update's own text
  // still replaces it when it runs (site-api v0.10.0), so the person is told first.
  function saveToSite(opener: HTMLElement | null) {
    if (data.pendingUpdate && data.status === "published") ask("save-live", opener);
    else void send("save");
  }

  return (
    <div className="app-page app-editor" data-layout={layout}>
      <PageHead
        renderLink={RouterLink}
        crumbs={[{ label: data.project.name, href: `/p/${data.project.slug}` }, { label: kindWord(data.kind) }]}
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
            It changed after this copy was started, so saving it will be refused. Discard the unsaved changes to load the site's version, then make them again.
          </Banner>
        ) : null}
        {data.ownDraft && mayEdit ? (
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
        {data.aiPublished && data.status === "published" ? (
          <Banner tone="info">
            {data.aiPublished.line} <Time at={data.aiPublished.at} format="exact" />
          </Banner>
        ) : null}
        {data.canEdit && live && !data.canPublish ? (
          <Banner tone="info">This {kindNoun(data.kind)} is live. Changes stay in Carrel, where everyone on it sees them; sending them to the site is the Owner's step, or its Author's.</Banner>
        ) : null}
        {data.pendingUpdate && data.status === "published" ? (
          <Banner
            tone="info"
            title={
              <>
                An update is scheduled for <Time at={data.pendingUpdate.publishAt} format="exact" />
              </>
            }
            actions={
              data.canPublish ? (
                <>
                  {data.pendingUpdate.source ? (
                    <Button size="sm" onClick={() => setSource(data.pendingUpdate!.source)}>
                      Edit the update
                    </Button>
                  ) : null}
                  <Button size="sm" variant="danger" pending={busy} onClick={(event) => ask("unschedule", event.currentTarget)}>
                    Cancel the update
                  </Button>
                </>
              ) : undefined
            }
          >
            The live {kindNoun(data.kind)} stays as it is until then, when the site publishes the scheduled text.
          </Banner>
        ) : null}
      </div>

      <div className="app-editor-grid">
        <div className="app-editor-main">
          <div className="app-editor-body" data-layout={layout}>
            {layout !== "preview" ? (
              <section className="app-editor-pane" aria-label="Write">
                {data.room ? editing.bar : null}
                {/* The front matter is not something a suggestion can mark, so only someone who may edit changes it. */}
                <FrontmatterFields source={source} onChange={setSource} readOnly={readOnly || !mayEdit} sections={data.sections} kind={data.kind} />
                <WritingSurface
                  label={kindWord(data.kind)}
                  value={splitSource(source).body}
                  onChange={(body) => setSource(joinSource({ ...splitSource(source), body }))}
                  readOnly={readOnly}
                  room={data.room ? { rich: editing.rich, markdownLocked: editing.markdownLocked } : undefined}
                  onEditor={editing.setEditor}
                  linkTargets={data.linkTargets.map((t) => ({ href: t.href, title: t.title, hint: t.href, note: t.state !== "published" ? `not live yet (${t.state})` : undefined }))}
                  media={data.media ? { ...data.media, figure: (url: string, alt: string, caption?: string) => figureMarkup(data.project.siteId, url, alt, caption) } : null}
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
        </div>

        <aside className="app-editor-side" aria-label="Binder, saving and publishing">
          <Panel title="Binder" src="This site's writing">
            <SiteBinder nodes={data.binder} current={data.itemId} />
          </Panel>
          {data.canEdit ? (
            <Panel title="This draft" src={data.version ? (data.status === "draft" ? "Draft on the site" : "On the site") : "Only in Carrel so far"}>
              <div className="app-stack" data-tight>
                <p role="status" className="app-savestate">
                  {saveState}
                </p>
                {data.pendingUpdate && data.status === "published" ? (
                  <p className="app-note">
                    An update waits to go live <Time at={data.pendingUpdate.publishAt} format="exact" />.
                  </p>
                ) : null}
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
                    <Button variant="primary" pending={busy} onClick={(event) => saveToSite(event.currentTarget)}>
                      Save draft to the site
                    </Button>
                  ) : null}
                  {onSite && maySave && saveTransition ? (
                    <Button variant={data.status === "draft" ? "default" : "primary"} pending={busy} onClick={(event) => saveToSite(event.currentTarget)}>
                      {/* Beside a scheduled update, plain "Update" could mean either; this one changes the live post now. */}
                      {data.status === "published" && data.scheduledUpdates && data.canPublish ? "Update the live post now" : saveTransition.label}
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
                  {onSite && data.canPublish && data.status === "published" && data.scheduledUpdates ? (
                    <Button onClick={(event) => ask("schedule", event.currentTarget)}>{data.pendingUpdate ? "Replace the scheduled update" : "Schedule as an update"}</Button>
                  ) : null}
                  {room.unsaved && onSite ? (
                    <Button variant="quiet" pending={busy} onClick={(event) => ask("discard", event.currentTarget)}>
                      Discard unsaved changes
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

          {data.room ? editing.panels : null}

          {/* Drawn once the page is live: Capsomer 0.36's gate shows the live time with <Time format="exact">,
              whose first render in a zone other than UTC differs from the server's and fails hydration. */}
          {onSite && data.canPublish && hydrated ? (
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

        {/* Flags, search and history: after the side column in the page's order, so on a phone saving and
            publishing come right after the text; on a wide screen they sit under the text (app.css). */}
        <div className="app-editor-more">
          {data.flags.length > 0 || data.aiDrafts.length > 0 ? (
            <FlagsPanel flags={data.flags} aiDrafts={data.aiDrafts} canPublish={data.canDismiss} onDismiss={(button, flag) => ask("dismiss", button, flag)} />
          ) : null}
          {seo ? <SearchSharingPanel check={seo} /> : null}
          {data.revisions || data.historyError ? (
            <HistoryPanel
              revisions={data.revisions}
              revisionCount={data.revisionCount}
              historyError={data.historyError}
              historyPath={historyPath}
              noun={kindNoun(data.kind)}
              againstSite={room.unsaved && onSite}
              aiDrafts={data.aiDrafts}
            />
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={asking?.kind === "discard"}
        title="Discard the unsaved changes?"
        lead="The text goes back to the site's version for everyone working on it, and every change since the last save is lost, suggestions too. This cannot be undone."
        body={[]}
        action="Discard unsaved changes"
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
      <ConfirmDialog
        open={asking?.kind === "save-live"}
        title="Change the live post now?"
        lead={
          data.pendingUpdate
            ? `Your save changes the live ${kindNoun(data.kind)} at once. The update scheduled for ${exactTime(data.pendingUpdate.publishAt)} still waits, and its own text replaces the live one then, without this change. To keep this change, replace the scheduled update with it.`
            : ""
        }
        body={[]}
        action="Save to the live post"
        returnTo={asking?.opener}
        perform={async () => void (await send("save"))}
        onClose={() => setAsking(null)}
      />
      <ConfirmDialog
        open={asking?.kind === "unschedule"}
        title="Cancel the scheduled update?"
        lead={data.pendingUpdate ? `The live ${kindNoun(data.kind)} stays as it is, and the update's text is dropped from the site. This cannot be undone.` : ""}
        body={[]}
        action="Cancel the update"
        cancelLabel="Keep the update"
        returnTo={asking?.opener}
        perform={async () => void (await send("unschedule"))}
        onClose={() => setAsking(null)}
      />
      <ScheduleDialog
        open={asking?.kind === "schedule"}
        noun={kindNoun(data.kind)}
        update={data.status === "published"}
        current={data.pendingUpdate?.publishAt ?? null}
        returnTo={asking?.opener}
        onClose={() => setAsking(null)}
        schedule={async (publishAt) => {
          await send("schedule", { publishAt });
          setAsking(null);
        }}
      />
    </div>
  );
}
