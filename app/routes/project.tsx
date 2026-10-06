// The one view for a site: every post the site reports, filtered by status and kind, searched with
// FTS5 over title and body. The list is Carrel's index; Refresh asks the site again.

import { ContentStatus } from "@dustinedwards/site-api";
import { Form, Link, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";
import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { kindsIn, refreshIndex, searchItems } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry } from "~/lib/sites.server";
import { waitingWork, withWaitingWork } from "~/lib/waiting.server";

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
  const viewer = getViewer(context);
  const [indexed, kinds, waiting] = await Promise.all([
    searchItems(env.DB, project.id, filters),
    kindsIn(env.DB, project.id),
    waitingWork(env.DB, project, viewer),
  ]);
  const items = withWaitingWork(indexed, waiting, filters);
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
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`Everything on ${project.site}, from Carrel's index of the site.`}
        actions={
          <>
            {connected ? (
              <Form method="post">
                <Button type="submit" name="intent" value="refresh" pending={refreshing}>
                  {refreshing ? "Refreshing" : "Refresh from the site"}
                </Button>
              </Form>
            ) : null}
            {canEdit && connected ? (
              <Link to="new" className="cap-btn" data-variant="primary">
                New post
              </Link>
            ) : null}
          </>
        }
      />

      <ProjectTabs slug={project.slug} current="posts" />

      {!connected ? (
        <Banner tone="warn" title="This site is not connected yet">
          {connectionDetail} Posts appear here once the site's key is set.
        </Banner>
      ) : null}

      {actionData?.error ? (
        <Alert tone="crit">The site could not be read: {actionData.error}</Alert>
      ) : actionData?.refreshed ? (
        <Banner tone="ok">
          {actionData.refreshed.listed} posts listed, {actionData.refreshed.fetched} read in full
          {actionData.refreshed.pending > 0 ? `, ${actionData.refreshed.pending} more on the next refresh` : ""}.
        </Banner>
      ) : null}

      <Panel title="Posts" count={items.length} src={`Carrel's index of ${project.site}`} flush>
        <div className="cap-panel-pad">
          <Form method="get" className="app-filters" role="search" aria-label="Filter posts">
            <Field label="Search">
              <input className="cap-input" type="search" name="q" defaultValue={filters.q ?? ""} placeholder="Words in the title or text" />
            </Field>
            <Field label="Status">
              <Select
                name="status"
                defaultValue={filters.status ?? ""}
                options={[
                  { value: "", label: "Any" },
                  { value: "draft", label: "Draft" },
                  { value: "scheduled", label: "Scheduled" },
                  { value: "published", label: "Published" },
                ]}
              />
            </Field>
            {kinds.length > 1 ? (
              <Field label="Kind">
                <Select name="kind" defaultValue={filters.kind ?? ""} options={[{ value: "", label: "Any" }, ...kinds.map((k) => ({ value: k, label: k }))]} />
              </Field>
            ) : null}
            <div className="app-actions">
              <Button type="submit" variant="primary">
                Filter
              </Button>
              {filtered ? (
                <Link to="." className="cap-btn">
                  Clear
                </Link>
              ) : null}
            </div>
          </Form>
        </div>

        {items.length === 0 ? (
          <Empty kind={filtered ? "no-match" : "nothing-yet"} flush title={filtered ? "No posts match" : "No posts in the index yet"} action={filtered ? <Link to="." className="cap-btn">Clear the filter</Link> : undefined}>
            {filtered ? "Nothing on this site fits the search and filters above." : "Refresh from the site to read what it has."}
          </Empty>
        ) : (
          <div className="cap-table-wrap" role="region" aria-labelledby="posts-caption" tabIndex={0}>
            <table className="cap-table">
              <caption id="posts-caption" className="cap-sr-only">
                Posts on {project.site}
              </caption>
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
                    <th scope="row">
                      <Link className="cap-table-open" to={`e/${encodeURIComponent(item.itemId)}`}>
                        {item.title || item.itemId}
                      </Link>
                      <span className="cap-table-aside">{item.path ?? item.itemId}</span>
                    </th>
                    <td>
                      {item.status === "published" ? (
                        <Pill tone="ok">Published</Pill>
                      ) : item.status === "scheduled" ? (
                        <Pill tone="info">Scheduled{item.publishAt ? ` ${when(item.publishAt)}` : ""}</Pill>
                      ) : (
                        <Pill variant="secondary">{item.isNew ? "New draft" : "Draft"}</Pill>
                      )}
                      {item.aiDrafts > 0 ? (
                        <Pill tone="info">
                          {item.aiDrafts === 1 ? "1 AI draft waiting" : `${item.aiDrafts} AI drafts waiting`}
                        </Pill>
                      ) : null}
                    </td>
                    <td>{item.updatedAt ? <Time at={item.updatedAt} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
