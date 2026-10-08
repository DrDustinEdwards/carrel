// The media library for one site (stage 3, and the v0.4.0 writes): browse, search, filter by tag,
// upload, edit a file's alt text and tags, move files to the trash and back, delete for good, over the
// site API's media group. The files are the site's, in its own storage and served by it; this page is
// only the screen. A Reader browses, an Editor also uploads, edits alt text and tags and uses the
// trash, and only the Owner deletes for good or empties the trash, and then only what the site's own
// reference check lets go. Each write is optional per site (the site's meta says which); the screen
// shows only what the site offers.
//
// The tiles, the bulk bar, the drop zone and the confirm dialog are Capsomer's; the details are a panel
// on the page, not a modal dialog, so they work without script (each edit is a form that posts).
// Selection and the bulk bar need script. Capsomer's own inspector autosaves through a client call;
// this page keeps server forms so the versioned writes, their refusals and the authorship record are
// one path. There are no folders: the dustinedwards media schema has none.

import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation, useRevalidator } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { BulkBar } from "capsomer/react/bulk-bar";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { DropZone } from "capsomer/react/drop-zone";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";
import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import {
  cleanMediaTag,
  deleteMedia,
  emptyMediaTrash,
  listMedia,
  listTrash,
  mediaDetail,
  mediaMeta,
  parseMediaTags,
  restoreMedia,
  setMediaAlt,
  setMediaTags,
  trashMedia,
  uploadMedia,
  type MediaOffers,
  type WriteOutcome,
} from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry, SiteNotConnected } from "~/lib/sites.server";
import { SiteApiError } from "@dustinedwards/site-api/client";

import type { Route } from "./+types/media";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Media · ${data.project.name} · Carrel` : "Carrel" }];
}

function reason(error: unknown): string | null {
  if (error instanceof SiteNotConnected) return `This site is not connected yet: ${error.detail}`;
  if (error instanceof SiteApiError) {
    if (error.status === 501) return "This site has no media library yet.";
    return error.body ? `The site refused: ${error.body.message}` : `The site answered ${error.status}.`;
  }
  return null;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().slice(0, 200) ?? "";
  const cursor = url.searchParams.get("cursor") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const tagText = url.searchParams.get("tag")?.trim() ?? "";
  const tag = tagText ? cleanMediaTag(tagText) : null;
  const wantsTrash = url.searchParams.get("view") === "trash";
  const base = {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: can(project.role, "read_mentions") },
    canUpload: can(project.role, "edit"),
    canDelete: can(project.role, "delete_media"),
    q,
    cursor,
  };
  const noOffers: MediaOffers = { alt: false, tags: false, trash: false };
  const empty = {
    limits: null,
    offers: noOffers,
    view: "library" as "library" | "trash",
    tag: "",
    tagInvalid: false,
    trashFiles: [] as { id: string; label: string }[],
    trashMore: false,
    items: [],
    nextCursor: null,
    detail: null,
    missingId: null,
  };
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected") return { ...base, ...empty, unavailable: `This site is not connected yet: ${connection.detail}` };
  try {
    // The limits first: a site on the v0.1.0 contract has no media routes to ask.
    const meta = await mediaMeta(env, project);
    if (!meta) return { ...base, ...empty, unavailable: "This site has no media library yet." };
    const { limits, offers } = meta;
    // A site that offers no trash has no Trash view; a site that keeps no tags ignores the tag filter.
    const view: "library" | "trash" = wantsTrash && offers.trash ? "trash" : "library";
    const [list, detail, trash] = await Promise.all([
      listMedia(env, project, { q: q || undefined, tag: offers.tags && tag ? tag : undefined, trashed: view === "trash" ? "only" : undefined, cursor: cursor || undefined, limit: 48 }),
      id ? mediaDetail(env, project, id) : Promise.resolve(null),
      // Emptying the trash names every file it will delete, so the Owner's Trash view lists them all (up to one request's worth).
      view === "trash" && can(project.role, "delete_media") ? listTrash(env, project) : Promise.resolve(null),
    ]);
    return {
      ...base,
      unavailable: null,
      limits,
      offers,
      view,
      tag: offers.tags && tag ? tag : "",
      tagInvalid: Boolean(offers.tags && tagText && !tag),
      trashFiles: trash ? trash.items.map((i) => ({ id: i.id, label: i.filename ?? i.id })) : [],
      trashMore: trash?.more ?? false,
      items: list.items,
      nextCursor: list.nextCursor,
      detail,
      missingId: id && !detail ? id : null,
    };
  } catch (error) {
    const message = reason(error);
    if (message === null) throw error;
    return { ...base, ...empty, unavailable: message };
  }
}

type WriteIntent = "set-alt" | "set-tags" | "trash" | "restore";
type Refusal = { id: string; message: string; usedBy: { type: string; id: string; title: string; detail: string }[] };

type ActionResult =
  | { intent: WriteIntent; ok: true; id: string; recorded: boolean }
  | { intent: WriteIntent; ok: false; id: string; message: string; conflict: boolean }
  | { intent: "empty-trash"; needsConfirm: true }
  | { intent: "empty-trash"; ok: true; deleted: string[]; refused: Refusal[]; more: boolean; unrecorded: number }
  | { intent: "empty-trash"; ok: false; message: string }
  | { intent: "upload"; ok: true; id: string; name: string }
  | { intent: "upload"; ok: false; message: string }
  | { intent: "delete"; needsConfirm: true; id: string }
  | { intent: "delete"; ok: true; id: string }
  | { intent: "delete"; ok: false; id: string; message: string; usedBy: { type: string; id: string; title: string; detail: string }[] };

export async function action({ params, request, context }: Route.ActionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "upload") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { intent, ok: false, message: "No file was chosen." };
    try {
      const outcome = await uploadMedia(env, project, { viewer }, { name: file.name, type: file.type, size: file.size, bytes: () => file.arrayBuffer() }, String(form.get("alt") ?? ""));
      return outcome.ok ? { intent, ok: true, id: outcome.item.id, name: outcome.item.filename ?? outcome.item.id } : { intent, ok: false, message: outcome.message };
    } catch (error) {
      const message = reason(error);
      if (message === null) throw error;
      return { intent, ok: false, message };
    }
  }
  if (intent === "delete") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "delete_media");
    const id = String(form.get("id") ?? "");
    // Two steps, as a first publish is: the file leaves the site's storage, and no undo brings it back.
    if (form.get("confirm") !== "delete") return { intent, needsConfirm: true, id };
    try {
      const outcome = await deleteMedia(env, project, { viewer }, id);
      return outcome.ok ? { intent, ok: true, id } : { intent, ok: false, id, message: outcome.message, usedBy: outcome.usedBy };
    } catch (error) {
      const message = reason(error);
      if (message === null) throw error;
      return { intent, ok: false, id, message, usedBy: [] };
    }
  }
  if (intent === "set-alt" || intent === "set-tags" || intent === "trash" || intent === "restore") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
    const id = String(form.get("id") ?? "");
    const version = String(form.get("version") ?? "");
    const outcome = await writeOutcome(async (): Promise<WriteOutcome> => {
      if (!version) return { ok: false, conflict: false, message: "Carrel does not know this file's version, so nothing was sent. Reload the page and try again." };
      if (intent === "set-alt") return setMediaAlt(env, project, { viewer }, id, String(form.get("alt") ?? ""), version);
      if (intent === "trash") return trashMedia(env, project, { viewer }, id, version);
      if (intent === "restore") return restoreMedia(env, project, { viewer }, id, version);
      const parsed = parseMediaTags(String(form.get("tags") ?? ""));
      if (!parsed.ok) return { ok: false, conflict: false, message: parsed.message };
      return setMediaTags(env, project, { viewer }, id, parsed.tags, version);
    });
    return outcome.ok ? { intent, ok: true, id, recorded: outcome.recorded } : { intent, ok: false, id, message: outcome.message, conflict: outcome.conflict };
  }
  if (intent === "empty-trash") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "delete_media");
    // Two steps, like delete: the page names every file first, because the files leave the site's storage for good.
    if (form.get("confirm") !== "empty") return { intent, needsConfirm: true };
    try {
      return { intent, ok: true, ...(await emptyMediaTrash(env, project, { viewer })) };
    } catch (error) {
      const message = error instanceof Response ? await error.text() : reason(error);
      if (message === null) throw error;
      return { intent, ok: false, message: message || "The site did not empty the trash." };
    }
  }
  throw new Response("Bad request", { status: 400 });
}

/** A site that is not connected or cannot be reached, said plainly for a write instead of a crash. */
async function writeOutcome(run: () => Promise<WriteOutcome>): Promise<WriteOutcome> {
  try {
    return await run();
  } catch (error) {
    const message = reason(error);
    if (message === null) throw error;
    return { ok: false, conflict: false, message };
  }
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function dims(width: number | null, height: number | null): string {
  return width && height ? `${width} by ${height}` : "not measured";
}


type FileOutcome = { id: string; ok: boolean; message: string; usedBy?: { type: string; id: string; title: string; detail: string }[] };
type BulkOp = "trash" | "restore" | "delete" | "add-tags" | "remove-tags";

const WRITE_INTENTS: readonly string[] = ["set-alt", "set-tags", "trash", "restore"];

export default function MediaLibrary({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canUpload, canDelete, q, tag, tagInvalid, view, offers, trashFiles, trashMore, unavailable, limits, items, nextCursor, detail, missingId } = loaderData;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle";
  const deleter = useFetcher<ActionResult>();
  const [confirming, setConfirming] = useState<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  const [emptying, setEmptying] = useState(false);
  // The selection is by file id; a file no longer listed (a filter, the trash, a delete) drops out of it.
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState("");
  const [bulkResult, setBulkResult] = useState<{ what: string; outcomes: FileOutcome[] } | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = resultRef.current;
    if (bulkResult && el) {
      el.tabIndex = -1;
      el.focus();
    }
  }, [bulkResult]);

  const trashView = view === "trash";
  const here = (over: Record<string, string>) => {
    const params = new URLSearchParams();
    const next = { q, tag, view: trashView ? "trash" : "", id: "", cursor: "", ...over };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    const text = params.toString();
    return text ? `?${text}` : ".";
  };
  const result = deleter.data ?? actionData;
  // Without script the Delete button posts and the server asks; with script the dialog asks first.
  const serverAsks = result?.intent === "delete" && "needsConfirm" in result ? result.id : null;
  const refused = result?.intent === "delete" && "ok" in result && !result.ok ? result : null;
  const written = result && WRITE_INTENTS.includes(result.intent) && "ok" in result ? (result as Extract<ActionResult, { intent: WriteIntent }>) : null;
  const emptied = result?.intent === "empty-trash" ? result : null;
  const name = detail ? (detail.filename ?? detail.id) : "";
  const writable = canUpload && Boolean(detail?.version);
  const inTrash = Boolean(detail?.trashedAt);

  // Selection and the bulk bar: only where the site has the v0.4.0 routes and the person may write.
  const bulkOffered = canUpload && (offers.tags || offers.trash);
  const versions = new Map(items.map((i) => [i.id, i.version ?? ""]));
  const chosen = items.filter((i) => selected.includes(i.id));
  const label = (i: { id: string; filename: string | null }) => i.filename ?? i.id;
  const run = (op: BulkOp, what: string) => async (picked: readonly { id: string; label: string }[]) => {
    if ((op === "add-tags" || op === "remove-tags") && bulkTags.trim() === "") throw new Error("Type a tag first.");
    const form = new FormData();
    form.set("op", op);
    if (op === "add-tags" || op === "remove-tags") form.set("tags", bulkTags);
    for (const p of picked) form.append("item", `${p.id}\t${versions.get(p.id) ?? ""}`);
    const response = await fetch(`/p/${encodeURIComponent(project.slug)}/media/bulk`, { method: "POST", body: form, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as { results?: FileOutcome[]; error?: string } | null;
    if (!response.ok || !body?.results) throw new Error(body?.error ?? `The server answered ${response.status}.`);
    setBulkResult({ what, outcomes: body.results });
    setSelected([]);
    void revalidator.revalidate();
  };
  const done = "Done. The result for each file is listed above the files.";
  const bulkActions = [
    ...(offers.tags
      ? [
          { id: "add-tags", label: "Add tag", said: done, run: run("add-tags", "Add tag") },
          { id: "remove-tags", label: "Remove tag", said: done, run: run("remove-tags", "Remove tag") },
        ]
      : []),
    ...(offers.trash
      ? [trashView ? { id: "restore", label: "Restore", said: done, run: run("restore", "Restore") } : { id: "trash", label: "Move to trash", said: done, run: run("trash", "Move to trash") }]
      : []),
    ...(canDelete
      ? [
          {
            id: "delete",
            label: "Delete for good",
            destructive: true,
            confirmTitle: "Delete {n} file{s} from the site?",
            confirmLead: `Each file below leaves ${project.site}'s storage, and nothing in Carrel can bring it back. The site's check refuses any file a post still uses, and that file stays.`,
            confirmAction: "Delete {n} file{s}",
            said: done,
            run: run("delete", "Delete for good"),
          },
        ]
      : []),
  ];

  return (
    <div className="app-page">
      <PageHead title={project.name} lead={`The files on ${project.site}, kept and served by the site. Carrel only shows them here.`} />

      <ProjectTabs slug={project.slug} current="media" mentions={project.mentions} />

      {unavailable ? (
        <Banner tone="warn">{unavailable}</Banner>
      ) : (
        <>
          {/* An alert on a refusal, a status on success: one is an event to act on, the other a confirmation. */}
          {actionData?.intent === "upload" ? (
            actionData.ok ? (
              <Banner tone="ok">
                Uploaded {actionData.name}. <Link to={here({ id: actionData.id })}>See its details</Link>.
              </Banner>
            ) : (
              <Alert tone="crit">{actionData.message}</Alert>
            )
          ) : null}
          {result?.intent === "delete" && "ok" in result && result.ok ? <Banner tone="ok">Deleted {result.id} from the site.</Banner> : null}

          {bulkResult ? (
            <Panel
              title="Result"
              id="media-result"
              ref={resultRef}
              src={`${bulkResult.what}: ${bulkResult.outcomes.filter((o) => o.ok).length} of ${bulkResult.outcomes.length} done`}
              actions={
                <Button size="sm" onClick={() => setBulkResult(null)}>
                  Clear this result
                </Button>
              }
            >
              <ul className="app-flags" aria-label="Result for each file">
                {bulkResult.outcomes.map((o) => (
                  <li key={o.id}>
                    {o.ok ? <Status tone="ok">Done</Status> : <Status tone="crit">Left as it was</Status>}
                    <span>
                      <strong className="cap-mono">{o.id}</strong>
                      <br />
                      {o.message}
                      {o.usedBy && o.usedBy.length > 0 ? (
                        <ul className="app-list">
                          {o.usedBy.map((use) => (
                            <li key={`${use.id}:${use.detail}`}>
                              Used by {use.title || use.id} ({use.detail})
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {emptied && "ok" in emptied && emptied.ok ? (
            <Panel title="Trash emptied" src={`${emptied.deleted.length} deleted, ${emptied.refused.length} kept`}>
              <p>
                {emptied.deleted.length === 0 ? "No file was deleted." : `Deleted ${emptied.deleted.length} ${emptied.deleted.length === 1 ? "file" : "files"} from the site.`}
                {emptied.more ? " More files remain in the trash; empty it again to continue." : ""}
                {emptied.unrecorded > 0 ? ` The site deleted them, but Carrel could not save the authorship record for ${emptied.unrecorded}.` : ""}
              </p>
              {emptied.refused.length > 0 ? (
                <Alert tone="warn" title="Kept in the trash">
                  <ul className="app-list">
                    {emptied.refused.map((r) => (
                      <li key={r.id}>
                        <span className="cap-mono">{r.id}</span>: {r.message}
                        {r.usedBy.length > 0 ? ` Used by ${r.usedBy.map((u) => `${u.title || u.id} (${u.detail})`).join(", ")}.` : ""}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </Panel>
          ) : null}
          {emptied && "ok" in emptied && !emptied.ok ? <Alert tone="crit">{emptied.message}</Alert> : null}
          {emptied && "needsConfirm" in emptied ? (
            <Alert tone="warn" title={`Delete everything in the trash from ${project.site}?`}>
              <Form method="post" className="app-form">
                <p>These files leave the site's storage, and nothing in Carrel can bring them back. The site refuses any a post still uses.</p>
                <ul className="app-list">
                  {trashFiles.map((f) => (
                    <li key={f.id}>{f.label}</li>
                  ))}
                </ul>
                {trashMore ? <p>The trash holds more than one request handles; the rest stay until you empty it again.</p> : null}
                <input type="hidden" name="confirm" value="empty" />
                <div className="app-actions">
                  <Button type="submit" name="intent" value="empty-trash" variant="danger" pending={busy}>
                    Empty the trash
                  </Button>
                  <Link to={here({})} className="cap-btn">
                    Keep them
                  </Link>
                </div>
              </Form>
            </Alert>
          ) : null}

          <div className="app-media" data-detail={detail || missingId ? "" : undefined}>
            <Panel
              title={trashView ? "Trash" : "Files"}
              count={items.length}
              src={`On ${project.site}`}
              flush
              actions={
                trashView && canDelete && trashFiles.length > 0 ? (
                  <Form method="post">
                    <Button
                      type="submit"
                      name="intent"
                      value="empty-trash"
                      variant="danger"
                      size="sm"
                      onClick={(event) => {
                        event.preventDefault();
                        setConfirming(event.currentTarget);
                        setEmptying(true);
                      }}
                    >
                      Empty the trash
                    </Button>
                  </Form>
                ) : undefined
              }
            >
              <div className="cap-panel-pad">
                {offers.trash ? (
                  <nav className="app-actions" aria-label="Library or trash">
                    <Link to={here({ view: "" })} className="cap-btn" data-variant={trashView ? undefined : "primary"} aria-current={trashView ? undefined : "page"}>
                      Library
                    </Link>
                    <Link to={here({ view: "trash" })} className="cap-btn" data-variant={trashView ? "primary" : undefined} aria-current={trashView ? "page" : undefined}>
                      Trash
                    </Link>
                  </nav>
                ) : null}
                <Form method="get" className="app-filters" role="search" aria-label="Search media">
                  {trashView ? <input type="hidden" name="view" value="trash" /> : null}
                  <Field label="Search">
                    <input className="cap-input" type="search" name="q" defaultValue={q} placeholder="Name, address or alt text" />
                  </Field>
                  {offers.tags ? (
                    <Field label="Tag" error={tagInvalid ? "A tag is lower case words joined by hyphens." : undefined}>
                      <input className="cap-input" type="text" name="tag" defaultValue={tag} autoComplete="off" placeholder="Only files with this tag" />
                    </Field>
                  ) : null}
                  <div className="app-actions">
                    <Button type="submit" variant="primary">
                      Search
                    </Button>
                    {q || tag ? (
                      <Link to={trashView ? "?view=trash" : "."} className="cap-btn">
                        Clear
                      </Link>
                    ) : null}
                  </div>
                </Form>
                {canUpload && limits && !trashView ? (
                  <Disclosure summary="Upload a file" defaultOpen={actionData?.intent === "upload" && !actionData.ok}>
                    <Form method="post" encType="multipart/form-data" className="app-form">
                      <DropZone name="file" accept={limits.types.join(",")} maxBytes={limits.maxBytes} maxFiles={1} hint={`Up to ${size(limits.maxBytes)}: ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`} />
                      <Field label="Alt text" help="What the image shows, for someone who cannot see it.">
                        <input className="cap-input" type="text" name="alt" autoComplete="off" />
                      </Field>
                      <div className="app-actions">
                        <Button type="submit" name="intent" value="upload" variant="primary" pending={busy && navigation.formData?.get("intent") === "upload"}>
                          Upload
                        </Button>
                      </div>
                    </Form>
                  </Disclosure>
                ) : null}
              </div>
              {items.length === 0 ? (
                <Empty
                  kind={q || tag ? "no-match" : "nothing-yet"}
                  flush
                  title={q || tag ? "Nothing matches" : trashView ? "The trash is empty" : "No files yet"}
                  action={q || tag ? <Link to={trashView ? "?view=trash" : "."} className="cap-btn">Clear the search</Link> : undefined}
                >
                  {q || tag
                    ? "Try the name, the address, the alt text or another tag."
                    : trashView
                      ? "Files you move to the trash wait here until you restore them or empty the trash."
                      : canUpload
                        ? "Upload the first file above, or drop one into a post's editor."
                        : "Files appear here once someone uploads them."}
                </Empty>
              ) : (
                <div className="cap-panel-pad">
                  <div className="cap-media" data-size="m">
                    <ul className="cap-media-grid" role="list" aria-label={trashView ? "Files in the trash" : "Files"}>
                      {items.map((item) => {
                        const image = item.contentType.startsWith("image/");
                        const itemLabel = label(item);
                        return (
                          <li key={item.id} className="cap-media-tile" data-active={detail?.id === item.id ? "" : undefined} data-selected={selected.includes(item.id) ? "" : undefined}>
                            {/* The whole tile is the link, named for the file: one tab stop per file. */}
                            <Link to={here({ id: item.id })} className="cap-media-open" preventScrollReset aria-describedby={`flags-${item.id}`} aria-current={detail?.id === item.id ? "true" : undefined}>
                              <span className="cap-media-thumb">
                                {image ? (
                                  <img src={item.src} alt="" loading="lazy" decoding="async" width={320} height={320} />
                                ) : (
                                  <span className="cap-media-doc" aria-hidden="true">
                                    {(item.contentType.split("/").pop() ?? "file").slice(0, 5).toUpperCase()}
                                  </span>
                                )}
                              </span>
                              <span className="cap-media-name" title={item.id}>
                                {itemLabel}
                              </span>
                              <span className="cap-media-meta">
                                {(item.contentType.split("/").pop() ?? "").toUpperCase()} · {size(item.bytes)}
                              </span>
                            </Link>
                            <span className="cap-media-flags" id={`flags-${item.id}`}>
                              {image && !item.alt && !trashView ? <Status tone="warn">No alt text</Status> : null}
                              {item.tags && item.tags.length > 0 ? <span className="cap-muted">{item.tags.join(", ")}</span> : null}
                            </span>
                            {bulkOffered ? (
                              <label className="cap-media-check">
                                <input
                                  type="checkbox"
                                  value={item.id}
                                  aria-label={`Select ${itemLabel}`}
                                  checked={selected.includes(item.id)}
                                  onChange={(event) => setSelected((now) => (event.target.checked ? [...now, item.id] : now.filter((id) => id !== item.id)))}
                                />
                                <span className="cap-media-check-box" aria-hidden="true">
                                  <svg viewBox="0 0 16 16">
                                    <path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M3.5 8.5l3 3 6-7" />
                                  </svg>
                                </span>
                                <span className="cap-media-check-word" aria-hidden="true">
                                  Selected
                                </span>
                              </label>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {nextCursor ? (
                    <p className="app-more">
                      <Link to={here({ cursor: nextCursor })} className="cap-btn">
                        Next page
                      </Link>
                    </p>
                  ) : null}
                </div>
              )}
            </Panel>

            {missingId ? (
              <Panel title="Details">
                <p>
                  The site has no file {missingId}. It may have been deleted. <Link to={here({})}>Back to the library</Link>.
                </p>
              </Panel>
            ) : null}

            {detail ? (
              <Panel title={name} level={2} headingId="detail-title" actions={<Link to={here({})} className="cap-btn" data-variant="quiet" data-size="sm" preventScrollReset>Close<span className="cap-sr-only"> the details</span></Link>}>
                <div className="app-detail">
                  {detail.contentType.startsWith("image/") ? (
                    <div className="cap-media-preview">
                      <img src={detail.src} alt="" width={640} height={427} />
                    </div>
                  ) : null}
                  {inTrash ? <Status tone="info">In the trash</Status> : null}
                  <dl className="app-facts">
                    <dt>Address on the site</dt>
                    <dd>
                      <code className="cap-mono">{detail.url}</code>
                    </dd>
                    <dt>Type</dt>
                    <dd>{detail.contentType}</dd>
                    <dt>Size</dt>
                    <dd>
                      {size(detail.bytes)}, {dims(detail.width, detail.height)}
                    </dd>
                    <dt>Uploaded</dt>
                    <dd>{detail.uploadedAt ? detail.uploadedAt.slice(0, 10) : "unknown"}</dd>
                    {!(offers.alt && writable && !inTrash) ? (
                      <>
                        <dt>Alt text</dt>
                        <dd>{detail.alt || <span className="cap-muted">none</span>}</dd>
                      </>
                    ) : null}
                    {offers.tags && !(writable && !inTrash) ? (
                      <>
                        <dt>Tags</dt>
                        <dd>{detail.tags && detail.tags.length > 0 ? detail.tags.join(", ") : <span className="cap-muted">none</span>}</dd>
                      </>
                    ) : null}
                  </dl>

                  {written && written.id === detail.id ? (
                    written.ok ? (
                      <Banner tone="ok">{written.intent === "trash" ? "Moved to the trash." : written.intent === "restore" ? "Restored to the library." : "Saved."}
                        {written.recorded ? "" : " The site has it, but Carrel could not save the authorship record."}
                      </Banner>
                    ) : (
                      <Alert tone={written.conflict ? "warn" : "crit"} title={written.conflict ? "The file changed" : "Not saved"}>
                        {written.message}
                      </Alert>
                    )
                  ) : null}

                  {offers.alt && writable && !inTrash ? (
                    <Form method="post" className="app-form" key={`alt:${detail.id}:${detail.version}`}>
                      <input type="hidden" name="id" value={detail.id} />
                      <input type="hidden" name="version" value={detail.version} />
                      <Field label="Alt text" help="What the image shows, for someone who cannot see it. Leave it empty for a picture that is only decoration.">
                        <textarea className="cap-input" name="alt" rows={3} defaultValue={detail.alt} maxLength={2000} />
                      </Field>
                      <div className="app-actions">
                        <Button type="submit" name="intent" value="set-alt" pending={busy && navigation.formData?.get("intent") === "set-alt"}>
                          Save alt text
                        </Button>
                      </div>
                    </Form>
                  ) : null}

                  {offers.tags && writable && !inTrash ? (
                    <Form method="post" className="app-form" key={`tags:${detail.id}:${detail.version}`}>
                      <input type="hidden" name="id" value={detail.id} />
                      <input type="hidden" name="version" value={detail.version} />
                      <Field label="Tags" help="Separate tags with commas. Lower case words joined by hyphens, up to 12.">
                        <input className="cap-input" type="text" name="tags" defaultValue={(detail.tags ?? []).join(", ")} autoComplete="off" />
                      </Field>
                      <div className="app-actions">
                        <Button type="submit" name="intent" value="set-tags" pending={busy && navigation.formData?.get("intent") === "set-tags"}>
                          Save tags
                        </Button>
                      </div>
                    </Form>
                  ) : null}
                  {offers.tags && detail.tags && detail.tags.length > 0 ? (
                    <p className="app-actions">
                      {detail.tags.map((t) => (
                        <Link key={t} to={here({ tag: t, id: "" })} className="cap-btn" data-size="sm">
                          Files tagged {t}
                        </Link>
                      ))}
                    </p>
                  ) : null}

                  <section aria-labelledby="used-title" className="app-section">
                    <h3 id="used-title">Used in</h3>
                    {detail.usedBy.length === 0 ? (
                      <p className="cap-muted">No post on the site uses it, as far as the site's check can see. A page elsewhere linking to it would not show here.</p>
                    ) : (
                      <ul className="app-list">
                        {detail.usedBy.map((use) => (
                          <li key={`${use.type}:${use.id}:${use.detail}`}>
                            {use.title || use.id} <span className="cap-muted">({use.detail})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {refused && refused.id === detail.id ? (
                    <Alert tone="crit" title="Not deleted">
                      {refused.message}
                      {refused.usedBy.length > 0 ? (
                        <ul className="app-list">
                          {refused.usedBy.map((use) => (
                            <li key={`${use.id}:${use.detail}`}>
                              {use.title || use.id} ({use.detail})
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Alert>
                  ) : null}

                  {offers.trash && writable ? (
                    <Form method="post">
                      <input type="hidden" name="id" value={detail.id} />
                      <input type="hidden" name="version" value={detail.version} />
                      <Button type="submit" name="intent" value={inTrash ? "restore" : "trash"} pending={busy && (navigation.formData?.get("intent") === "trash" || navigation.formData?.get("intent") === "restore")}>
                        {inTrash ? "Restore" : "Move to trash"}
                        <span className="cap-sr-only"> {name}</span>
                      </Button>
                    </Form>
                  ) : null}

                  {canDelete && detail.deletable ? (
                    serverAsks === detail.id ? (
                      <Alert tone="warn" title={`Delete ${name} from ${project.site}?`}>
                        <Form method="post" className="app-form">
                          <p>The file leaves the site's storage, and nothing in Carrel can bring it back.</p>
                          <input type="hidden" name="id" value={detail.id} />
                          <input type="hidden" name="confirm" value="delete" />
                          <div className="app-actions">
                            <Button type="submit" name="intent" value="delete" variant="danger" pending={busy}>
                              Delete from the site
                            </Button>
                            <Link to={here({ id: detail.id })} className="cap-btn" preventScrollReset>
                              Keep it
                            </Link>
                          </div>
                        </Form>
                      </Alert>
                    ) : (
                      <Form method="post">
                        <input type="hidden" name="id" value={detail.id} />
                        <Button
                          type="submit"
                          name="intent"
                          value="delete"
                          variant="danger"
                          onClick={(event) => {
                            event.preventDefault();
                            setConfirming(event.currentTarget);
                            setAsking(true);
                          }}
                        >
                          Delete<span className="cap-sr-only"> {name}</span>
                        </Button>
                      </Form>
                    )
                  ) : null}
                </div>
              </Panel>
            ) : null}
          </div>

          {bulkOffered && items.length > 0 ? (
            <BulkBar
              items={chosen.map((i) => ({ id: i.id, label: label(i) }))}
              total={items.length}
              onSelectAll={() => setSelected(items.map((i) => i.id))}
              onClear={() => setSelected([])}
              actions={bulkActions}
            >
              {offers.tags ? (
                <span className="cap-bulk-field">
                  <label htmlFor="bulk-tags">Tag</label>
                  <input className="cap-input" id="bulk-tags" value={bulkTags} onChange={(event) => setBulkTags(event.target.value)} autoComplete="off" />
                </span>
              ) : null}
            </BulkBar>
          ) : null}

          <ConfirmDialog
            open={asking}
            title={`Delete ${name} from the site?`}
            lead="The file leaves the site's storage, and nothing in Carrel can bring it back."
            body={detail && detail.usedBy.length > 0 ? ["The site's check lists places that use it, and may refuse."] : []}
            action="Delete from the site"
            returnTo={confirming}
            perform={async () => {
              if (!detail) return;
              await deleter.submit({ intent: "delete", id: detail.id, confirm: "delete" }, { method: "post" });
            }}
            onClose={() => setAsking(false)}
          />

          <ConfirmDialog
            open={emptying}
            title={`Delete ${trashFiles.length} ${trashFiles.length === 1 ? "file" : "files"} in the trash?`}
            lead={`Every file below leaves ${project.site}'s storage, and nothing in Carrel can bring it back. The site refuses any file a post still uses, and that file stays in the trash.`}
            body={[...trashFiles.map((f) => f.label), ...(trashMore ? ["The trash holds more than one request handles; the rest stay until you empty it again."] : [])]}
            action="Empty the trash"
            returnTo={confirming}
            perform={async () => {
              await deleter.submit({ intent: "empty-trash", confirm: "empty" }, { method: "post" });
            }}
            onClose={() => setEmptying(false)}
          />
        </>
      )}
    </div>
  );
}
