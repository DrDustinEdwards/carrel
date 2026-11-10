// Writing: every post and page on every site the viewer may open, in one table, from the index Desk keeps
// in D1 (refreshed every 15 minutes, and at once by a save in Desk). A scope chip narrows it to one site;
// the tabs are the status. A row opens the editor on its site. "waiting=ai" narrows to posts that have AI
// drafts waiting beside the person's own, which is where Home's "Review" lands.

import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pill } from "capsomer/react/status";
import { TabsNav } from "capsomer/react/tabs";
import { Time } from "capsomer/react/time";
import { Form } from "react-router";

import { ScopeChip } from "~/components/scope-chip";
import { getEnv, getViewer } from "~/lib/context";
import { writingRows } from "~/lib/desk.server";
import { visibleProjects } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { waitingWork } from "~/lib/waiting.server";

import type { Route } from "./+types/writing";

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
  return {
    sites: sites.map((p) => ({ slug: p.slug, name: p.name })),
    site,
    status,
    q,
    waitingAi,
    counts,
    rows: shown,
    // A new post is made on one site: the scoped one, or the only one.
    newHref: site ? `/p/${site}/new` : sites.length === 1 ? `/p/${sites[0]!.slug}/new` : null,
  };
}

export default function Writing({ loaderData }: Route.ComponentProps) {
  const { sites, site, status, q, waitingAi, counts, rows, newHref } = loaderData;
  const href = (next: { status?: string }) => {
    const p = new URLSearchParams();
    if (site) p.set("site", site);
    if (q) p.set("q", q);
    if (waitingAi) p.set("waiting", "ai");
    if (next.status && next.status !== "all") p.set("status", next.status);
    const s = p.toString();
    return s ? `/writing?${s}` : "/writing";
  };
  return (
    <div className="app-page">
      <PageHead
        title="Writing"
        lead="Every post and page, on every site."
        actions={
          <>
            <ScopeChip
              sites={sites}
              value={site}
              keep={{
                q,
                status: status === "all" ? undefined : status,
                waiting: waitingAi ? "ai" : undefined,
              }}
            />
            {newHref ? (
              <Link to={newHref} className="cap-btn" data-variant="primary">
                New post
              </Link>
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
        <button className="cap-btn" type="submit">
          Search
        </button>
        {waitingAi ? (
          <Pill variant="secondary">
            With AI drafts waiting · <Link to={href({ status })}>Clear</Link>
          </Pill>
        ) : null}
      </Form>
      {rows.length === 0 ? (
        <Empty kind="nothing-yet" title={q || waitingAi ? "Nothing matches" : "No posts yet"}>
          {q || waitingAi
            ? "Try fewer words, another status or all sites."
            : "A post appears here once a site you can open lists it."}
        </Empty>
      ) : (
        <div className="cap-table-wrap" role="region" aria-label="Posts" tabIndex={0}>
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col" data-drop="1">
                  Site
                </th>
                <th scope="col">Status</th>
                <th scope="col" data-drop="2" data-num>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.projectId}/${r.itemId}`}>
                  <th scope="row">
                    <Link className="cap-table-open" to={r.href}>
                      {r.title}
                    </Link>
                    <span className="cap-table-aside" data-drop="1">
                      {r.site}
                    </span>
                  </th>
                  <td data-drop="1">{r.site}</td>
                  <td>
                    <Pill variant={TONE[r.status]}>
                      {LABEL[r.status === "draft" ? "draft" : r.status].replace(/s$/, "")}
                    </Pill>
                  </td>
                  <td data-drop="2" data-num>
                    {r.at ? <Time at={r.at} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
