// The media library for one site (stage 3): browse, search, upload, details and delete, over the site
// API's media group. The files are the site's, in its own storage and served by it; this page is only
// the screen. A Reader browses, an Editor also uploads, and only the Owner deletes, and then only what
// the site's own reference check lets go.
//
// The tiles and the drop zone are Capsomer's; the details are a panel on the page, not a modal dialog,
// so they work without script. Capsomer's inspector edits alt text, tags and a bin, which the site API
// (v0.2.0) has no routes for, so Carrel's inspector shows the file's facts, where it is used, and the
// Owner's permanent delete behind a confirm dialog.

import { useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
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
import { deleteMedia, listMedia, mediaDetail, mediaLimits, uploadMedia } from "~/lib/media.server";
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
  const base = {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    canUpload: can(project.role, "edit"),
    canDelete: can(project.role, "delete_media"),
    q,
    cursor,
  };
  const empty = { limits: null, items: [], nextCursor: null, detail: null, missingId: null };
  const connection = siteConnection(env, project.site);
  if (connection.state !== "connected") return { ...base, ...empty, unavailable: `This site is not connected yet: ${connection.detail}` };
  try {
    // The limits first: a site on the v0.1.0 contract has no media routes to ask.
    const limits = await mediaLimits(env, project);
    if (!limits) return { ...base, ...empty, unavailable: "This site has no media library yet." };
    const [list, detail] = await Promise.all([
      listMedia(env, project, { q: q || undefined, cursor: cursor || undefined, limit: 48 }),
      id ? mediaDetail(env, project, id) : Promise.resolve(null),
    ]);
    return { ...base, unavailable: null, limits, items: list.items, nextCursor: list.nextCursor, detail, missingId: id && !detail ? id : null };
  } catch (error) {
    const message = reason(error);
    if (message === null) throw error;
    return { ...base, ...empty, unavailable: message };
  }
}

type ActionResult =
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
  throw new Response("Bad request", { status: 400 });
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function dims(width: number | null, height: number | null): string {
  return width && height ? `${width} by ${height}` : "not measured";
}

export default function MediaLibrary({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canUpload, canDelete, q, unavailable, limits, items, nextCursor, detail, missingId } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const deleter = useFetcher<ActionResult>();
  const [confirming, setConfirming] = useState<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  const here = (over: Record<string, string>) => {
    const params = new URLSearchParams();
    const next = { q, id: "", cursor: "", ...over };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    const text = params.toString();
    return text ? `?${text}` : ".";
  };
  const result = deleter.data ?? actionData;
  // Without script the Delete button posts and the server asks; with script the dialog asks first.
  const serverAsks = result?.intent === "delete" && "needsConfirm" in result ? result.id : null;
  const refused = result?.intent === "delete" && "ok" in result && !result.ok ? result : null;
  const name = detail ? (detail.filename ?? detail.id) : "";

  return (
    <div className="app-page">
      <PageHead title={project.name} lead={`The files on ${project.site}, kept and served by the site. Carrel only shows them here.`} />

      <ProjectTabs slug={project.slug} current="media" />

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

          <div className="app-media" data-detail={detail || missingId ? "" : undefined}>
            <Panel title="Files" count={items.length} src={`On ${project.site}`} flush>
              <div className="cap-panel-pad">
                <Form method="get" className="app-filters" role="search" aria-label="Search media">
                  <Field label="Search">
                    <input className="cap-input" type="search" name="q" defaultValue={q} placeholder="Name, address or alt text" />
                  </Field>
                  <div className="app-actions">
                    <Button type="submit" variant="primary">
                      Search
                    </Button>
                    {q ? (
                      <Link to="." className="cap-btn">
                        Clear
                      </Link>
                    ) : null}
                  </div>
                </Form>
                {canUpload && limits ? (
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
                  kind={q ? "no-match" : "nothing-yet"}
                  flush
                  title={q ? `Nothing matches \u201c${q}\u201d` : "No files yet"}
                  action={q ? <Link to="." className="cap-btn">Clear the search</Link> : undefined}
                >
                  {q ? "Try the name, the address or the alt text." : canUpload ? "Upload the first file above, or drop one into a post's editor." : "Files appear here once someone uploads them."}
                </Empty>
              ) : (
                <div className="cap-panel-pad">
                  <div className="cap-media" data-size="m">
                    <ul className="cap-media-grid" role="list" aria-label="Files">
                      {items.map((item) => {
                        const image = item.contentType.startsWith("image/");
                        const label = item.filename ?? item.id;
                        return (
                          <li key={item.id} className="cap-media-tile" data-active={detail?.id === item.id ? "" : undefined}>
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
                                {label}
                              </span>
                              <span className="cap-media-meta">
                                {(item.contentType.split("/").pop() ?? "").toUpperCase()} · {size(item.bytes)}
                              </span>
                            </Link>
                            <span className="cap-media-flags" id={`flags-${item.id}`}>
                              {image && !item.alt ? <Status tone="warn">No alt text</Status> : null}
                            </span>
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
                    <dt>Alt text</dt>
                    <dd>{detail.alt || <span className="cap-muted">none</span>}</dd>
                  </dl>

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
        </>
      )}
    </div>
  );
}
