// Writing: every post and page on every site the viewer may open, in one table, from the index Desk keeps
// in D1 (refreshed every 15 minutes, and at once by a save in Desk). A scope chip narrows it to one site;
// the tabs are the status. A row opens the editor on its site. "waiting=ai" narrows to posts that have AI
// drafts waiting beside the person's own, which is where Home's "Review" lands.
//
// A row's title opens its peek (`?inspect=<site>/<item>`, the detail panel, driven by the address so it
// works with no script); its Open goes to the editor. The boxes and the bulk bar are a plain form: the
// ticked posts and the intent post here, each site's share runs through that site's own posts intent
// (writing.server.ts), and the page comes back with one outcome per post, the Undo and any confirm.

import { Table } from "capsomer/react/table";
import { Link, ButtonLink } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pill } from "capsomer/react/status";
import { TabsNav } from "capsomer/react/tabs";
import { Time } from "capsomer/react/time";
import { BulkBar } from "capsomer/react/bulk-bar";
import { ConfirmPage } from "capsomer/react/confirm-dialog";
import { DetailPanel, DetailSection } from "capsomer/react/detail-panel";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { useState } from "react";
import { Form, useNavigate } from "react-router";

import { ScopeChip } from "capsomer/react/scope-chip";
import { getEnv, getViewer } from "~/lib/context";
import { writingRows } from "~/lib/desk.server";
import { readForm } from "~/lib/form.server";
import { peekOf, postKey, runWritingIntent, type WritingResult } from "~/lib/writing-list.server";
import { visibleProjects } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { waitingWork } from "~/lib/waiting.server";

import type { Route } from "./+types/writing";
import "capsomer/scope-chip.css";
import "capsomer/publish-gate.css";
import "capsomer/summary-list.css";
import "capsomer/detail-panel.css";

export function meta() {
  return [{ title: "Writing · Carrel" }];
}

const STATUSES = ["all", "draft", "scheduled", "published"] as const;
const LABEL = {
  all: "All",
  draft: "Drafts",
  scheduled: "Scheduled",
  published: "Published",
} as const;
const TONE = { draft: "secondary", scheduled: "outline", published: "default" } as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const search = new URL(request.url).searchParams;
  const visible = await visibleProjects(env.DB, viewer);
  const sites = visible.filter((p) => p.kind === "site" && can(p.role, "read"));
  const site = sites.some((p) => p.slug === search.get("site")) ? (search.get("site") ?? "") : "";
  const status = STATUSES.find((s) => s === search.get("status")) ?? "all";
  const q = (search.get("q") ?? "").slice(0, 200);
  const waitingAi = search.get("waiting") === "ai";
  const inspect = search.get("inspect") ?? "";
  const { rows, counts } = await writingRows(env.DB, visible, {
    site: site || undefined,
    q,
    status,
  });
  let shown = rows;
  const aiBy = new Map<string, number>();
  if (waitingAi) {
    for (const p of sites.filter((s) => !site || s.slug === site)) {
      for (const w of await waitingWork(env.DB, { id: p.id, role: p.role }, viewer))
        if (w.aiDrafts > 0) aiBy.set(`${p.id}/${w.itemId}`, w.aiDrafts);
    }
    shown = rows.filter((r) => aiBy.has(`${r.projectId}/${r.itemId}`));
  }
  const peek = inspect ? await peekOf(env, viewer, visible, inspect.slice(0, 600)) : null;
  // The boxes are for a person who can change posts on at least one site; each site still checks its own.
  const editable = new Set(sites.filter((p) => can(p.role, "edit")).map((p) => p.slug));
  return {
    sites: sites.map((p) => ({ slug: p.slug, name: p.name })),
    site,
    status,
    q,
    waitingAi,
    counts,
    rows: shown.map((r) => ({
      ...r,
      key: postKey(r.siteSlug, r.itemId),
      selectable: editable.has(r.siteSlug),
    })),
    peek,
    inspect,
    // A new post is made on one site: the scoped one, or the only one.
    newHref: site ? `/p/${site}/new` : sites.length === 1 ? `/p/${sites[0]!.slug}/new` : null,
  };
}

export async function action({ request, context }: Route.ActionArgs): Promise<WritingResult> {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  const visible = await visibleProjects(env.DB, viewer);
  // The outcomes name each post as the list does, "title · site", from the index.
  const { rows } = await writingRows(env.DB, visible, {}, 5000);
  const names = new Map(rows.map((r) => [postKey(r.siteSlug, r.itemId), `${r.title} · ${r.site}`]));
  return runWritingIntent(env, viewer, form, (key) => names.get(key) ?? key);
}

const PEEK_STATUS = { draft: "Draft", scheduled: "Scheduled", published: "Published" } as const;

export default function Writing({ loaderData, actionData }: Route.ComponentProps) {
  const { sites, site, status, q, waitingAi, counts, rows, newHref, peek, inspect } = loaderData;
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<WritingResult | null>(null);
  const result = actionData && actionData !== dismissed ? actionData : null;
  const selectable = rows.some((r) => r.selectable);
  const toggle = (key: string, on: boolean) =>
    setSelected((s) => (on ? [...new Set([...s, key])] : s.filter((k) => k !== key)));
  const href = (next: { status?: string; inspect?: string }) => {
    const p = new URLSearchParams();
    if (site) p.set("site", site);
    if (q) p.set("q", q);
    if (waitingAi) p.set("waiting", "ai");
    if (next.inspect) p.set("inspect", next.inspect);
    if (next.status && next.status !== "all") p.set("status", next.status);
    const s = p.toString();
    return s ? `/writing?${s}` : "/writing";
  };
  if (result?.confirm) {
    const c = result.confirm;
    return (
      <div className="app-page">
        <ConfirmPage
          title={c.title}
          lead={c.lead}
          body={c.items}
          action_label={c.action}
          typeToConfirm={c.typeToConfirm}
          cancelHref={href({ status })}
          hidden={{ intent: c.intent, ids: c.ids, ...(c.tag ? { tag: c.tag } : {}) }}
        />
      </div>
    );
  }
  const items = rows
    .filter((r) => selected.includes(r.key))
    .map((r) => ({ id: r.key, label: `${r.title} · ${r.site}` }));
  return (
    <div className="app-page">
      <PageHead
        title="Writing"
        lead="Every post and page, on every site."
        actions={
          <>
            <ScopeChip
              options={sites.map((s) => ({ value: s.slug, label: s.name }))}
              value={site}
              label="Show posts from"
              all="All sites"
              name="site"
              renderForm={(props) => <Form {...props} />}
              keep={{
                q,
                status: status === "all" ? undefined : status,
                waiting: waitingAi ? "ai" : undefined,
              }}
            />
            {newHref ? (
              <ButtonLink to={newHref} variant="primary">
                New post
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <TabsNav aria-label="Status" variant="line">
        {STATUSES.map((s) => (
          <Link
            key={s}
            to={href({ status: s })}
            className="cap-tab"
            aria-current={s === status ? "page" : undefined}
          >
            {LABEL[s]} <span className="app-tab-count">{counts[s]}</span>
          </Link>
        ))}
      </TabsNav>
      <Form method="get" className="app-toolbar" role="search">
        {site ? <input type="hidden" name="site" value={site} /> : null}
        {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
        {waitingAi ? <input type="hidden" name="waiting" value="ai" /> : null}
        <label className="app-toolbar-search">
          <span className="cap-sr-only">Search titles</span>
          <input
            className="cap-input"
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search titles"
          />
        </label>
        <Button type="submit">Search</Button>
        {waitingAi ? (
          <Pill variant="secondary">
            With AI drafts waiting · <Link to={href({ status })}>Clear</Link>
          </Pill>
        ) : null}
      </Form>
      {result && !result.confirm ? (
        <Banner tone={result.ok ? "ok" : "warn"} title={result.message}>
          {result.undo ? (
            <Form method="post">
              <input type="hidden" name="intent" value="undo" />
              <input type="hidden" name="plan" value={result.undo.plan} />
              <Button type="submit">Undo</Button>
            </Form>
          ) : null}
        </Banner>
      ) : null}
      {selectable ? (
        <Form method="post" id="writing-bulk" className="app-writing-bulk">
          <BulkBar
            form="writing-bulk"
            items={items}
            total={rows.filter((r) => r.selectable).length}
            onSelectAll={() => setSelected(rows.filter((r) => r.selectable).map((r) => r.key))}
            onClear={() => setSelected([])}
            prompt="Tick the posts to act on"
            outcomes={result?.outcomes.length ? result.outcomes : undefined}
            onDismissOutcomes={() => setDismissed(actionData ?? null)}
            actions={[
              { id: "unpublish", label: "Unpublish", submit: true },
              { id: "tag-add", label: "Add tag", submit: true },
              { id: "tag-remove", label: "Remove tag", submit: true },
              { id: "trash", label: "Move to Trash", submit: true, destructive: true },
            ]}
          >
            <span className="cap-bulk-field">
              <label htmlFor="writing-tag">Tag</label>
              <input className="cap-input" id="writing-tag" name="tag" form="writing-bulk" />
            </span>
          </BulkBar>
        </Form>
      ) : null}
      {rows.length === 0 ? (
        <Empty kind="nothing-yet" title={q || waitingAi ? "Nothing matches" : "No posts yet"}>
          {q || waitingAi
            ? "Try fewer words, another status or all sites."
            : "A post appears here once a site you can open lists it."}
        </Empty>
      ) : (
        <Table caption="Posts" captionHidden className="app-writing-wrap" reflow>
          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className="app-check-col">
                  <span className="cap-sr-only">Select</span>
                </th>
              ) : null}
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col" data-drop="2" data-num>
                Updated
              </th>
              <th scope="col">
                <span className="cap-sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                data-selected={selected.includes(r.key) ? "" : undefined}
                data-current={r.key === inspect ? "" : undefined}
              >
                {selectable ? (
                  <td className="app-check-col">
                    {r.selectable ? (
                      <label className="cap-check">
                        <input
                          type="checkbox"
                          name="ids"
                          value={r.key}
                          form="writing-bulk"
                          checked={selected.includes(r.key)}
                          onChange={(e) => toggle(r.key, e.target.checked)}
                        />
                        <span className="cap-sr-only">Select {r.title}</span>
                      </label>
                    ) : null}
                  </td>
                ) : null}
                <th scope="row">
                  <Link
                    className="cap-table-open"
                    to={href({ status, inspect: r.key })}
                    preventScrollReset
                  >
                    {r.title}
                  </Link>
                  <span className="cap-table-aside">
                    {r.site} · {r.kind}
                  </span>
                </th>
                <td>
                  <Pill variant={TONE[r.status]}>
                    {LABEL[r.status === "draft" ? "draft" : r.status].replace(/s$/, "")}
                  </Pill>
                </td>
                <td data-drop="2" data-num>
                  {r.at ? <Time at={r.at} /> : null}
                </td>
                <td>
                  <ButtonLink size="sm" to={r.href}>
                    Open<span className="cap-sr-only"> {r.title}</span>
                  </ButtonLink>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {peek ? (
        <DetailPanel
          open
          onClose={() =>
            void navigate(href({ status }), { preventScrollReset: true, replace: true })
          }
          id="writing-peek"
          title={peek.title}
          kind={`${peek.kind} · ${peek.site}`}
          identifier={peek.itemId}
          badge={<Pill variant={TONE[peek.status]}>{PEEK_STATUS[peek.status]}</Pill>}
        >
          <DetailSection title="Open it">
            <div className="cap-detail-controls">
              <ButtonLink variant="primary" to={peek.editHref}>
                Open in the editor
              </ButtonLink>
              {peek.liveUrl ? (
                <ButtonLink href={peek.liveUrl} away newTab>
                  View on the site
                </ButtonLink>
              ) : null}
              <ButtonLink to={peek.historyHref}>History</ButtonLink>
            </div>
          </DetailSection>
          {peek.aiDrafts > 0 || peek.ownDraft || peek.flags > 0 ? (
            <DetailSection title="Waiting">
              <ul className="app-peek-waiting">
                {peek.ownDraft ? <li>Your draft is saved beside the site's text.</li> : null}
                {peek.aiDrafts > 0 ? (
                  <li>
                    {peek.aiDrafts === 1 ? "1 AI draft" : `${peek.aiDrafts} AI drafts`} waiting to
                    be read.
                  </li>
                ) : null}
                {peek.flags > 0 ? (
                  <li>
                    <Link to={`${peek.siteHref}/flags`}>
                      {peek.flags === 1 ? "1 open flag" : `${peek.flags} open flags`}
                    </Link>
                  </li>
                ) : null}
              </ul>
            </DetailSection>
          ) : null}
          <DetailSection title="Record">
            <dl className="cap-detail-record">
              <dt>Site</dt>
              <dd>
                <Link to={peek.siteHref}>{peek.site}</Link>
              </dd>
              <dt>Address</dt>
              <dd>{peek.path ?? "Not on the site yet"}</dd>
              {peek.publishAt && peek.status === "scheduled" ? (
                <>
                  <dt>Goes live</dt>
                  <dd>
                    <Time at={peek.publishAt} />
                  </dd>
                </>
              ) : null}
              {peek.updateAt ? (
                <>
                  <dt>Update goes live</dt>
                  <dd>
                    <Time at={peek.updateAt} />
                  </dd>
                </>
              ) : null}
              {peek.publishedAt ? (
                <>
                  <dt>Published</dt>
                  <dd>
                    <Time at={peek.publishedAt} />
                  </dd>
                </>
              ) : null}
              {peek.updatedAt ? (
                <>
                  <dt>Updated</dt>
                  <dd>
                    <Time at={peek.updatedAt} />
                  </dd>
                </>
              ) : null}
            </dl>
          </DetailSection>
          <p className="cap-detail-source">
            From Desk's index of {peek.site}, read from the site <Time at={peek.syncedAt} />.
          </p>
        </DetailPanel>
      ) : null}
    </div>
  );
}
