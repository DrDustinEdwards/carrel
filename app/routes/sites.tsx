// Sites: one row per site with what it holds and what waits, and the way into its pages (posts, media,
// legal, mentions, flags, voice, 404s). The Owner's: a site's settings are not an editor's.

import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pill } from "capsomer/react/status";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findings, siteItems } from "~/db/schema";
import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/sites";

export function meta() {
  return [{ title: "Sites · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Forbidden", { status: 403 });
  const sites = (await visibleProjects(env.DB, viewer)).filter((p) => p.kind === "site");
  const ids = sites.map((s) => s.id);
  const d = drizzle(env.DB);
  const [items, flags] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          d
            .select({ projectId: siteItems.projectId, status: siteItems.status, n: count() })
            .from(siteItems)
            .where(inArray(siteItems.projectId, ids))
            .groupBy(siteItems.projectId, siteItems.status)
            .all(),
          d
            .select({ projectId: findings.projectId, n: count() })
            .from(findings)
            .where(and(eq(findings.status, "open"), inArray(findings.projectId, ids)))
            .groupBy(findings.projectId)
            .all(),
        ]);
  const n = (id: number, status: string) =>
    items.find((i) => i.projectId === id && i.status === status)?.n ?? 0;
  return {
    sites: sites.map((s) => ({
      slug: s.slug,
      name: s.name,
      published: n(s.id, "published"),
      drafts: n(s.id, "draft"),
      scheduled: n(s.id, "scheduled"),
      flags: flags.find((f) => f.projectId === s.id)?.n ?? 0,
    })),
  };
}

export default function Sites({ loaderData }: Route.ComponentProps) {
  const { sites } = loaderData;
  return (
    <div className="app-page">
      <PageHead title="Sites" lead="Each site Desk writes to, and what it holds." />
      {sites.length === 0 ? (
        <Empty kind="nothing-yet" title="No sites yet">
          A site appears here once its key is set.
        </Empty>
      ) : (
        <div className="cap-table-wrap" role="region" aria-label="Sites" tabIndex={0}>
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col" data-num>
                  Published
                </th>
                <th scope="col" data-drop="1" data-num>
                  Drafts
                </th>
                <th scope="col" data-drop="1" data-num>
                  Scheduled
                </th>
                <th scope="col" data-num>
                  Flags
                </th>
                <th scope="col">
                  <span className="cap-sr-only">Pages</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.slug}>
                  <th scope="row">
                    <Link className="cap-table-open" to={`/p/${s.slug}`}>
                      {s.name}
                    </Link>
                  </th>
                  <td data-num>{s.published}</td>
                  <td data-drop="1" data-num>
                    {s.drafts}
                  </td>
                  <td data-drop="1" data-num>
                    {s.scheduled}
                  </td>
                  <td data-num>{s.flags > 0 ? <Pill tone="warn">{s.flags}</Pill> : 0}</td>
                  <td>
                    <Link to={`/p/${s.slug}/legal`} className="cap-btn">
                      Settings
                    </Link>
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
