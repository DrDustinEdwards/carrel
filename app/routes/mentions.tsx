// The webmention queue for a site: what other sites sent about its posts, in one table, filtered by
// status. The Owner approves, rejects or deletes the chosen mentions and sweeps the expired ones; each
// write goes to the site, which saves it and clears the post's cache as one step. Everything a
// stranger sent is drawn as text: the source address is never a link.

import { useEffect, useRef, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { BulkBar } from "capsomer/react/bulk-bar";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";
import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { isMentionFilter, listMentions, mentionsOffered, type MentionFilter } from "~/lib/mentions.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/mentions";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Mentions · ${data.project.name} · Carrel` : "Carrel" }];
}

const FILTER_LABEL: Record<MentionFilter, string> = {
  pending: "Pending",
  failed: "Failed",
  approved: "Approved",
  rejected: "Rejected",
  unverified: "Unverified",
  all: "All",
};

const EMPTY_LINE: Record<MentionFilter, string> = {
  pending: "No pending mentions.",
  failed: "No failed mentions.",
  approved: "No approved mentions.",
  rejected: "No rejected mentions.",
  unverified: "No unverified mentions.",
  all: "No mentions yet.",
};

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  // The Owner's alone, as carrel/design.md puts the inbox: anyone else is refused before the site is asked.
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read_mentions");
  const head = { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: true };
  const support = await mentionsOffered(env, project);
  if (!support.offered) return { project: head, offered: false as const, reason: support.reason };
  const url = new URL(request.url);
  const requested = url.searchParams.get("status");
  try {
    const { filter, list } = await listMentions(env, project, {
      filter: isMentionFilter(requested) ? requested : null,
      cursor: url.searchParams.get("cursor") || undefined,
    });
    return { project: head, offered: true as const, filter, list, paged: url.searchParams.has("cursor") };
  } catch (error) {
    console.error(JSON.stringify({ mentions: "list-failed", error: String(error) }));
    return { project: head, offered: false as const, reason: "The site did not answer, so its mentions cannot be listed. Try again in a moment." };
  }
}

type Outcome = { id: string; ok: boolean; message: string };
type Op = "approve" | "reject" | "delete";

const DONE = "Done. The result for each mention is listed below the table.";

export default function Mentions({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;
  const revalidator = useRevalidator();
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<{ what: string; outcomes: Outcome[] } | null>(null);
  const [sweepNote, setSweepNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [sweepOpen, setSweepOpen] = useState(false);
  const sweepOpener = useRef<HTMLElement | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!result) return;
    const el = resultRef.current;
    if (el) {
      el.tabIndex = -1;
      el.focus();
    }
  }, [result]);

  if (!loaderData.offered) {
    return (
      <div className="app-page">
        <PageHead title={project.name} lead={`Webmentions about posts on ${project.site}.`} />
        <ProjectTabs slug={project.slug} current="mentions" mentions />
        <Banner tone="warn" title="Mentions are not available for this site yet">
          {loaderData.reason}
        </Banner>
      </div>
    );
  }

  const { filter, list, paged } = loaderData;
  const items = list.items;
  const names = new Map(items.map((m) => [m.id, m.authorName ?? "An unnamed sender"]));
  const chosen = items.filter((m) => selected.includes(m.id));
  const expired = list.expiring.failed + list.expiring.rejected;
  const total = Object.values(list.counts).reduce((a, b) => a + b, 0);
  const base = `/p/${encodeURIComponent(project.slug)}/mentions/api`;

  const post = async (form: FormData) => {
    const response = await fetch(base, { method: "POST", body: form, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as { results?: Outcome[]; sweep?: { ok: boolean; message: string }; error?: string } | null;
    if (!response.ok || !body) throw new Error(body?.error ?? `The server answered ${response.status}.`);
    return body;
  };

  const run = (op: Op, what: string) => async (picked: readonly { id: string; label: string }[]) => {
    const form = new FormData();
    form.set("op", op);
    const sent = items.filter((m) => picked.some((p) => p.id === m.id)).map((m) => ({ id: m.id, version: m.version, status: m.status }));
    form.set("items", JSON.stringify(sent));
    const body = await post(form);
    if (!body.results) throw new Error(body.error ?? "The server gave no result.");
    setResult({ what, outcomes: body.results });
    // A mention that was acted on has moved or gone, so it leaves the selection.
    setSelected((now) => now.filter((id) => !body.results!.some((o) => o.id === id && o.ok)));
    void revalidator.revalidate();
  };

  const sweep = async () => {
    const form = new FormData();
    form.set("op", "sweep");
    const body = await post(form);
    if (!body.sweep) throw new Error(body.error ?? "The server gave no result.");
    setSweepNote(body.sweep);
    void revalidator.revalidate();
    if (!body.sweep.ok) throw new Error(body.sweep.message);
  };

  const filtered = filter !== "all";
  const countIn = (f: MentionFilter) => (f === "all" ? total : list.counts[f]);

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={
          filter === "pending" && items.length > 0
            ? `Webmentions about posts on ${project.site}. Approving one shows it on the post within seconds.`
            : `Webmentions about posts on ${project.site}.`
        }
      />

      <ProjectTabs slug={project.slug} current="mentions" mentions />

      {/* The status region is always in the DOM, so a result is announced. */}
      <div role="status">{sweepNote?.ok ? <Banner tone="ok">{sweepNote.message}</Banner> : null}</div>
      {sweepNote && !sweepNote.ok ? <Alert tone="crit">{sweepNote.message}</Alert> : null}

      {result ? (
        <Panel
          title="Result"
          id="mention-result"
          ref={resultRef}
          src={`${result.what}: ${result.outcomes.filter((o) => o.ok).length} of ${result.outcomes.length} done`}
          actions={
            <Button size="sm" onClick={() => setResult(null)}>
              Clear this result
            </Button>
          }
        >
          <ul className="app-flags" aria-label="Result for each mention">
            {result.outcomes.map((o) => (
              <li key={o.id}>
                {o.ok ? <Status tone="ok">Done</Status> : <Status tone="crit">Left as it was</Status>}
                <span>
                  <strong>{names.get(o.id) ?? `Mention ${o.id}`}</strong> <span className="cap-mono cap-muted">{o.id}</span>
                  <br />
                  {o.message}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Mentions" count={items.length} src={`${FILTER_LABEL[filter]} on ${project.site}`} flush>
        <div className="cap-panel-pad">
          <Form method="get" className="app-filters" role="search" aria-label="Filter mentions">
            <Field label="Status">
              <Select
                name="status"
                defaultValue={filter}
                options={(["pending", "failed", "approved", "rejected", "unverified", "all"] as const).map((f) => ({ value: f, label: `${FILTER_LABEL[f]} (${countIn(f)})` }))}
              />
            </Field>
            <div className="app-actions">
              <Button type="submit" variant="primary">
                Filter
              </Button>
            </div>
          </Form>
        </div>

        {items.length === 0 ? (
          <Empty kind={filtered ? "all-clear" : "nothing-yet"} flush title={EMPTY_LINE[filter]}>
            {total === 0 ? "Nothing has been sent to this site yet." : `${total} mention${total === 1 ? "" : "s"} in other views.`}
          </Empty>
        ) : (
          <div className="cap-table-wrap" role="region" aria-labelledby="mentions-caption" tabIndex={0}>
            <table className="cap-table">
              <caption id="mentions-caption" className="cap-sr-only">
                {FILTER_LABEL[filter]} mentions of posts on {project.site}
              </caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="cap-sr-only">Select</span>
                  </th>
                  <th scope="col">From</th>
                  <th scope="col">What it says</th>
                  <th scope="col">Post</th>
                  <th scope="col">Status</th>
                  <th scope="col">Received</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => {
                  const from = m.authorName ?? "an unnamed sender";
                  return (
                    <tr key={m.id} data-state={selected.includes(m.id) ? "selected" : undefined}>
                      <td>
                        <label className="cap-check">
                          <input
                            type="checkbox"
                            checked={selected.includes(m.id)}
                            onChange={(event) => setSelected((now) => (event.target.checked ? [...now, m.id] : now.filter((id) => id !== m.id)))}
                          />
                          <span className="cap-sr-only">Select the mention from {from}</span>
                        </label>
                      </td>
                      <th scope="row" data-wrap>
                        {m.authorName ?? "An unnamed sender"}
                        {/* Text, not a link: the sender chose this string. */}
                        <span className="cap-table-aside" data-mention-source="">
                          {m.sourceUrl}
                        </span>
                      </th>
                      <td data-wrap>
                        {m.excerpt ?? <span className="cap-muted">No excerpt</span>}
                        {m.failureReason ? <span className="cap-table-aside">Reason: {m.failureReason}</span> : null}
                      </td>
                      <td>
                        <Link to={`/p/${encodeURIComponent(project.slug)}/e/${encodeURIComponent(m.targetId)}`}>{m.targetId}</Link>
                      </td>
                      <td>
                        {m.status === "approved" ? (
                          <Pill tone="ok">Approved</Pill>
                        ) : m.status === "pending" ? (
                          <Pill tone="info">Pending</Pill>
                        ) : m.status === "failed" ? (
                          <Pill tone="crit">Failed</Pill>
                        ) : (
                          <Pill variant="secondary">{m.status === "rejected" ? "Rejected" : "Unverified"}</Pill>
                        )}
                        {m.decidedAt ? (
                          <span className="cap-table-aside">
                            Decided <Time at={m.decidedAt} />
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <Time at={m.receivedAt} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {list.nextCursor || paged ? (
          <div className="cap-panel-pad app-actions">
            {paged ? (
              <Link to={`?status=${filter}`} className="cap-btn">
                First page
              </Link>
            ) : null}
            {list.nextCursor ? (
              <Link to={`?status=${filter}&cursor=${encodeURIComponent(list.nextCursor)}`} className="cap-btn">
                Next page
              </Link>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Retention">
        <p>The site removes failed and rejected mentions once they pass its retention window. Pending and approved ones are never removed.</p>
        <p>
          {expired === 0
            ? "None are past the window now."
            : `${expired} past the window now: ${list.expiring.failed} failed, ${list.expiring.rejected} rejected.`}
        </p>
        <div className="app-actions">
          <Button
            disabledReason={expired === 0 ? "Nothing is past the retention window." : undefined}
            onClick={(event) => {
              sweepOpener.current = event.currentTarget;
              setSweepOpen(true);
            }}
          >
            Remove {expired} expired
          </Button>
        </div>
      </Panel>

      <BulkBar
        items={chosen.map((m) => ({ id: m.id, label: `${m.authorName ?? "An unnamed sender"} on ${m.targetId} (${m.status})` }))}
        total={items.length}
        onSelectAll={() => setSelected(items.map((m) => m.id))}
        onClear={() => setSelected([])}
        actions={[
          { id: "approve", label: "Approve", said: DONE, run: run("approve", "Approve") },
          { id: "reject", label: "Reject", said: DONE, run: run("reject", "Reject") },
          {
            id: "delete",
            label: "Delete",
            destructive: true,
            confirmTitle: "Delete {n} mention{s} permanently?",
            confirmLead: `Each mention below is removed from ${project.site}. This removes the only copy of what the sender sent; nothing else has one. Reject it instead if you may want it back.`,
            confirmAction: "Delete {n} mention{s}",
            said: DONE,
            run: run("delete", "Delete"),
          },
        ]}
      />

      <ConfirmDialog
        open={sweepOpen}
        title={`Remove ${expired} expired mention${expired === 1 ? "" : "s"}?`}
        lead="The site removes these permanently. Nothing else has a copy of them."
        body={[`${list.expiring.failed} failed`, `${list.expiring.rejected} rejected`]}
        action={`Remove ${expired}`}
        returnTo={sweepOpener.current}
        perform={sweep}
        onClose={() => setSweepOpen(false)}
      />
    </div>
  );
}
