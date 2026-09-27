// The media library for one site (stage 3): browse, search, upload, details and delete, over the site
// API's media group. The files are the site's, in its own storage and served by it; this page is only
// the screen. A Reader browses, an Editor also uploads, and only the Owner deletes, and then only what
// the site's own reference check lets go.
//
// The grid, tile and inspector follow DrDustinEdwards/dustinedwards-info@f84b978
// (app/components/admin/media-grid.tsx, media-tile.tsx, media-inspector.tsx, media-upload-actions.tsx,
// media-empty-state.tsx), cut to what the site API carries: no bulk selection, trash, tags, facets,
// twins or keyboard grid, since v0.2.0 has no routes for them. The inspector is a panel on the page,
// not a modal dialog, so it works without script.

import { Form, Link, useNavigation } from "react-router";

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
  return width && height ? `${width} x ${height}` : "not measured";
}

export default function MediaLibrary({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canUpload, canDelete, q, unavailable, limits, items, nextCursor, detail, missingId } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const here = (over: Record<string, string>) => {
    const params = new URLSearchParams();
    const next = { q, id: "", cursor: "", ...over };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    const text = params.toString();
    return text ? `?${text}` : ".";
  };
  const confirming = actionData?.intent === "delete" && "needsConfirm" in actionData ? actionData.id : null;
  const refused = actionData?.intent === "delete" && "ok" in actionData && !actionData.ok ? actionData : null;
  const name = detail ? (detail.filename ?? detail.id) : "";

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={`/p/${project.slug}`}>{project.name}</Link>
        </p>
        <h1>Media</h1>
        <p className="muted">The files on {project.site}, kept and served by the site. Carrel only shows them here.</p>
      </header>

      {unavailable ? (
        <p className="notice" role="status">
          {unavailable}
        </p>
      ) : (
        <>
          <div className="toolbar-row">
            <Form method="get" className="filters" role="search" aria-label="Search media">
              <label className="field">
                <span>Search</span>
                <input type="search" name="q" defaultValue={q} placeholder="Name, address or alt text" />
              </label>
              <button type="submit" className="btn">
                Search
              </button>
              {q ? (
                <Link to="." className="btn-ghost">
                  Clear
                </Link>
              ) : null}
            </Form>
          </div>

          {canUpload && limits ? (
            <Form method="post" encType="multipart/form-data" className="media-upload">
              <label className="field">
                <span>File</span>
                <input type="file" name="file" accept={limits.types.join(",")} required />
              </label>
              <label className="field">
                <span>Alt text</span>
                <input type="text" name="alt" placeholder="What the image shows" />
              </label>
              <button type="submit" name="intent" value="upload" className="btn" disabled={busy}>
                Upload
              </button>
              <p className="muted media-upload-hint">
                Up to {size(limits.maxBytes)}: {limits.types.map((t) => t.split("/")[1]).join(", ")}.
              </p>
            </Form>
          ) : null}

          {/* An alert on a refusal, a status on success: one is an event to act on, the other a confirmation. */}
          {actionData?.intent === "upload" ? (
            actionData.ok ? (
              <p className="notice" role="status">
                Uploaded {actionData.name}. <Link to={here({ id: actionData.id })}>See its details</Link>.
              </p>
            ) : (
              <p className="alarm" role="alert">
                {actionData.message}
              </p>
            )
          ) : null}
          {actionData?.intent === "delete" && "ok" in actionData && actionData.ok ? (
            <p className="notice" role="status">
              Deleted {actionData.id} from the site.
            </p>
          ) : null}

          <div className="media-layout" data-detail={detail || missingId ? "" : undefined}>
            <section aria-label="Files">
              {items.length === 0 ? (
                <div className="media-empty">
                  {q ? (
                    <p>
                      Nothing matches &ldquo;{q}&rdquo;. <Link to=".">Clear the search</Link>.
                    </p>
                  ) : (
                    <p>Nothing here yet.{canUpload ? " Upload the first file above, or drop one into a post's editor." : ""}</p>
                  )}
                </div>
              ) : (
                <ul className="media-grid">
                  {items.map((item) => (
                    <li key={item.id} className="media-card" data-active={detail?.id === item.id || undefined}>
                      {/* The whole tile is the link, named for the file: one tab stop per file. */}
                      <Link to={here({ id: item.id })} className="media-thumb-link" preventScrollReset aria-label={item.filename ?? item.id}>
                        <span className="media-thumb-box">
                          {item.contentType.startsWith("image/") ? (
                            <img className="media-thumb" src={item.src} alt="" loading="lazy" decoding="async" width={320} height={320} />
                          ) : (
                            <span className="media-thumb-label" aria-hidden="true">
                              {(item.contentType.split("/").pop() ?? "file").toUpperCase()}
                            </span>
                          )}
                        </span>
                        <span className="media-name" title={item.id}>
                          {item.filename ?? item.id}
                        </span>
                        <span className="media-meta">
                          {size(item.bytes)}
                          {item.alt ? "" : " · no alt text"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {nextCursor ? (
                <p>
                  <Link to={here({ cursor: nextCursor })} className="btn-ghost">
                    Next page
                  </Link>
                </p>
              ) : null}
            </section>

            {missingId ? (
              <aside className="media-detail" aria-label="Details">
                <p className="muted">
                  The site has no file {missingId}. It may have been deleted. <Link to={here({})}>Back to the library</Link>.
                </p>
              </aside>
            ) : null}

            {detail ? (
              <aside className="media-detail" aria-label={`Details for ${name}`}>
                <header className="media-detail-head">
                  <h2 title={detail.id}>{name}</h2>
                  <Link to={here({})} preventScrollReset aria-label="Close the details">
                    <span aria-hidden="true">&times;</span>
                  </Link>
                </header>
                {detail.contentType.startsWith("image/") ? <img className="media-detail-preview" src={detail.src} alt="" width={640} height={427} /> : null}
                <dl className="media-facts">
                  <dt>Address on the site</dt>
                  <dd>
                    <code>{detail.url}</code>
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
                  <dd>{detail.alt || <span className="muted">none</span>}</dd>
                </dl>

                <h3>Used in</h3>
                {detail.usedBy.length === 0 ? (
                  <p className="muted">
                    No post on the site uses it, as far as the site's check can see. A page elsewhere linking to it would not show here.
                  </p>
                ) : (
                  <ul className="media-uses">
                    {detail.usedBy.map((use) => (
                      <li key={`${use.type}:${use.id}:${use.detail}`}>
                        {use.title || use.id} <span className="muted">({use.detail})</span>
                      </li>
                    ))}
                  </ul>
                )}

                {refused && refused.id === detail.id ? (
                  <div className="alarm" role="alert">
                    <p>Not deleted. {refused.message}</p>
                    {refused.usedBy.length > 0 ? (
                      <ul>
                        {refused.usedBy.map((use) => (
                          <li key={`${use.id}:${use.detail}`}>
                            {use.title || use.id} ({use.detail})
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                {canDelete && detail.deletable ? (
                  <Form method="post" className="confirm">
                    <input type="hidden" name="id" value={detail.id} />
                    {confirming === detail.id ? (
                      <>
                        <p>
                          Delete {name} from {project.site}? The file leaves the site's storage, and nothing in Carrel can bring it back.
                        </p>
                        <p>
                          <button type="submit" name="intent" value="delete" className="btn-danger" disabled={busy}>
                            Delete from the site
                          </button>{" "}
                          <input type="hidden" name="confirm" value="delete" />
                          <Link to={here({ id: detail.id })} className="btn-ghost" preventScrollReset>
                            Keep it
                          </Link>
                        </p>
                      </>
                    ) : (
                      <p>
                        <button type="submit" name="intent" value="delete" className="btn-danger" disabled={busy}>
                          Delete
                        </button>
                      </p>
                    )}
                  </Form>
                ) : null}
              </aside>
            ) : null}
          </div>
        </>
      )}
    </main>
  );
}
