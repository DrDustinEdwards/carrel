// The one view for a site: every post the site reports, filtered by status and kind, searched with
// FTS5 over title and body. The list is Carrel's index; Refresh asks the site again.

import { ContentStatus } from "@dustinedwards/site-api";
import { Form, Link, useNavigation } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { kindsIn, refreshIndex, searchItems } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/project";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const url = new URL(request.url);
  const status = ContentStatus.safeParse(url.searchParams.get("status"));
  const filters = {
    q: url.searchParams.get("q")?.trim() || undefined,
    status: status.success ? status.data : undefined,
    kind: url.searchParams.get("kind")?.trim() || undefined,
  };
  const [items, kinds] = await Promise.all([searchItems(env.DB, project.id, filters), kindsIn(env.DB, project.id)]);
  const connection = siteConnection(env, project.site);
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    canEdit: can(project.role, "edit"),
    connected: connection.state === "connected",
    connectionDetail: connection.state === "connected" ? null : connection.detail,
    filters,
    kinds,
    items,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const form = await request.formData();
  if (form.get("intent") !== "refresh") throw new Response("Bad request", { status: 400 });
  try {
    const result = await refreshIndex(env, { id: project.id, site: project.site });
    return { refreshed: result, error: null };
  } catch (error) {
    return { refreshed: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const STATUS_LABEL = { draft: "Draft", scheduled: "Scheduled", published: "Published" } as const;

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

export default function Project({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canEdit, connected, connectionDetail, filters, kinds, items } = loaderData;
  const navigation = useNavigation();
  const refreshing = navigation.state !== "idle" && navigation.formData?.get("intent") === "refresh";
  const filtered = Boolean(filters.q || filters.status || filters.kind);

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>{project.name}</h1>
        <p className="muted">Everything on {project.site}, from Carrel's index of the site.</p>
        <p>
          <Link to={`/p/${project.slug}/media`}>Media</Link>
        </p>
      </header>

      {!connected ? (
        <p className="notice" role="status">
          This site is not connected yet: {connectionDetail} Posts appear here once the site's key is set.
        </p>
      ) : null}

      <div className="toolbar-row">
        <Form method="get" className="filters" role="search" aria-label="Filter posts">
          <label className="field">
            <span>Search</span>
            <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder="Words in the title or text" />
          </label>
          <label className="field">
            <span>Status</span>
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">Any</option>
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="published">Published</option>
            </select>
          </label>
          {kinds.length > 1 ? (
            <label className="field">
              <span>Kind</span>
              <select name="kind" defaultValue={filters.kind ?? ""}>
                <option value="">Any</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button type="submit" className="btn">
            Filter
          </button>
          {filtered ? (
            <Link to="." className="btn-ghost">
              Clear
            </Link>
          ) : null}
        </Form>

        <div className="actions">
          {connected ? (
            <Form method="post">
              <button type="submit" name="intent" value="refresh" className="btn-ghost" disabled={refreshing}>
                {refreshing ? "Refreshing" : "Refresh from the site"}
              </button>
            </Form>
          ) : null}
          {canEdit && connected ? (
            <Link to="new" className="btn">
              New post
            </Link>
          ) : null}
        </div>
      </div>

      {actionData?.error ? (
        <p className="alarm" role="alert">
          The site could not be read: {actionData.error}
        </p>
      ) : actionData?.refreshed ? (
        <p className="muted" role="status">
          {actionData.refreshed.listed} posts listed, {actionData.refreshed.fetched} read in full
          {actionData.refreshed.pending > 0 ? `, ${actionData.refreshed.pending} more on the next refresh` : ""}.
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="muted">{filtered ? "No posts match." : "No posts in the index yet."}</p>
      ) : (
        <table className="items">
          <caption className="sr-only">Posts on {project.site}</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <Link to={`e/${encodeURIComponent(item.itemId)}`}>{item.title || item.itemId}</Link>
                  <span className="muted item-id">{item.path ?? item.itemId}</span>
                </td>
                <td>
                  <span className={`status status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  {item.status === "scheduled" && item.publishAt ? (
                    <span className="muted"> {when(item.publishAt)}</span>
                  ) : null}
                </td>
                <td className="muted">{when(item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
