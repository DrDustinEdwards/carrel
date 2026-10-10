// The one view for a site: every post the site reports, filtered by status and kind, searched with
// FTS5 over title and body. The list is Carrel's index; Refresh asks the site again.

import { ContentStatus } from "@dustinedwards/site-api";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { BulkBar } from "capsomer/react/bulk-bar";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";
import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { contentDeleteOffered } from "~/lib/content.server";
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
  // Delete is the Owner's, and a site may not offer it. The Owner is told which, and why, beside the actions.
  const canDelete = can(project.role, "delete_content");
  const deleteSupport = canDelete && connection.state === "connected" ? await contentDeleteOffered(env, project) : null;
  return {
    canDelete,
    deleteOffered: deleteSupport?.offered === true,
    deleteReason: deleteSupport && !deleteSupport.offered ? deleteSupport.reason : null,
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: can(project.role, "read_mentions") },
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

type BulkOutcome = { id: string; title: string; ok: boolean; message: string; copyId?: string };
type BulkOp = "tag-add" | "tag-remove" | "duplicate" | "delete";

const DONE = "Done. The result for each post is listed below the table.";

export default function Project({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canEdit, canDelete, deleteOffered, deleteReason, connected, connectionDetail, filters, kinds, items } = loaderData;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  // The selection is by post id; a post no longer listed (a filter, a delete) drops out of it.
  const [selected, setSelected] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [result, setResult] = useState<{ what: string; outcomes: BulkOutcome[] } | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  // Only a post the site holds can be acted on; one that exists only in Carrel (an AI draft for a new post) cannot.
  const selectable = items.filter((i) => !i.isNew);
  const chosen = selectable.filter((i) => selected.includes(i.itemId));
  useEffect(() => {
    if (!result) return;
    const el = resultRef.current;
    if (el) {
      el.tabIndex = -1;
      el.focus();
    }
  }, [result]);

  const run = (op: BulkOp, what: string) => async (picked: readonly { id: string; label: string }[]) => {
    if ((op === "tag-add" || op === "tag-remove") && tag.trim() === "") throw new Error("Type a tag first.");
    const form = new FormData();
    form.set("op", op);
    if (op === "tag-add" || op === "tag-remove") form.set("tag", tag);
    for (const p of picked) form.append("id", p.id);
    const response = await fetch(`/p/${encodeURIComponent(project.slug)}/bulk`, { method: "POST", body: form, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as { results?: BulkOutcome[]; error?: string } | null;
    if (!response.ok || !body?.results) throw new Error(body?.error ?? `The server answered ${response.status}.`);
    setResult({ what, outcomes: body.results });
    void revalidator.revalidate();
  };
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

      <ProjectTabs slug={project.slug} current="posts" mentions={project.mentions} />

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

      {result ? (
        <Panel
          title="Result"
          id="bulk-result"
          ref={resultRef}
          src={`${result.what}: ${result.outcomes.filter((o) => o.ok).length} of ${result.outcomes.length} done`}
          actions={
            <Button size="sm" onClick={() => setResult(null)}>
              Clear this result
            </Button>
          }
        >
          <ul className="app-flags" aria-label="Result for each post">
            {result.outcomes.map((o) => (
              <li key={o.id}>
                {o.ok ? <Status tone="ok">Done</Status> : <Status tone="crit">Left as it was</Status>}
                <span>
                  <strong>{o.title}</strong> <span className="cap-mono cap-muted">{o.id}</span>
                  <br />
                  {o.message}
                  {o.copyId ? (
                    <>
                      {" "}
                      <Link to={`e/${encodeURIComponent(o.copyId)}`}>Open the copy</Link>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
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
                  {canEdit ? (
                    <th scope="col">
                      <span className="cap-sr-only">Select</span>
                    </th>
                  ) : null}
                  <th scope="col">Title</th>
                  {kinds.length > 1 ? <th scope="col">Kind</th> : null}
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.itemId} data-state={selected.includes(item.itemId) ? "selected" : undefined}>
                    {canEdit ? (
                      <td>
                        <label className="cap-check">
                          <input
                            type="checkbox"
                            checked={selected.includes(item.itemId)}
                            disabled={item.isNew}
                            onChange={(event) => setSelected((now) => (event.target.checked ? [...now, item.itemId] : now.filter((id) => id !== item.itemId)))}
                          />
                          <span className="cap-sr-only">
                            Select {item.title || item.itemId}
                            {item.isNew ? " (only in Carrel, so it cannot be acted on in bulk)" : ""}
                          </span>
                        </label>
                      </td>
                    ) : null}
                    <th scope="row">
                      <Link className="cap-table-open" to={`e/${encodeURIComponent(item.itemId)}`}>
                        {item.title || item.itemId}
                      </Link>
                      <span className="cap-table-aside">{item.path ?? item.itemId}</span>
                    </th>
                    {kinds.length > 1 ? <td>{item.kind}</td> : null}
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

      {canEdit ? (
        <BulkBar
          items={chosen.map((i) => ({ id: i.itemId, label: `${i.title || i.itemId} (${i.itemId})` }))}
          total={selectable.length}
          onSelectAll={() => setSelected(selectable.map((i) => i.itemId))}
          onClear={() => setSelected([])}
          actions={[
            { id: "tag-add", label: "Add tag", said: DONE, run: run("tag-add", "Add tag") },
            { id: "tag-remove", label: "Remove tag", said: DONE, run: run("tag-remove", "Remove tag") },
            { id: "duplicate", label: "Duplicate", said: DONE, run: run("duplicate", "Duplicate") },
            ...(canDelete && deleteOffered
              ? [
                  {
                    id: "delete",
                    label: "Delete",
                    destructive: true,
                    confirmTitle: "Delete {n} post{s} from the site?",
                    confirmLead: `Each post below is removed from ${project.site}. Carrel cannot bring one back; the site's own history may still hold its text. Your working drafts of them stay in Carrel.`,
                    confirmAction: "Delete {n} post{s}",
                    said: DONE,
                    run: run("delete", "Delete"),
                  },
                ]
              : []),
          ]}
        >
          <span className="cap-bulk-field">
            <label htmlFor="bulk-tag">Tag</label>
            <input className="cap-input" id="bulk-tag" value={tag} onChange={(event) => setTag(event.target.value)} autoComplete="off" />
          </span>
          {canDelete && deleteReason ? <span className="cap-bulk-detail">Delete is not offered: {deleteReason}</span> : null}
        </BulkBar>
      ) : null}
    </div>
  );
}
