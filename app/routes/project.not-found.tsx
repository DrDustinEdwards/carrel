// The paths readers asked a site for that it does not have, from the 404s the site counts (site-api
// v0.16.0, GET /insight/not-found): most hits first over the last 30 days, with the hosts that linked to
// each, so a broken link or a moved page can be fixed. Read only. Paths and hosts are what strangers
// sent, so they are drawn as text, never as links.

import { SiteApiError } from "@dustinedwards/site-api/client";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Status } from "capsomer/react/status";

import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient, siteEntry, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/project.not-found";

const DAYS = 30;

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `404s · ${data.project.name} · Carrel` : "Carrel" }];
}

/** "example.com 2, no referrer 1": the hosts that linked to the path, most hits first. */
function referrers(list: { host: string; hits: number }[]): string {
  return list.map((r) => `${r.host || "no referrer"} ${r.hits}`).join(", ");
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const head = { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: can(project.role, "read_mentions") };
  try {
    const { rows } = await siteClient(env, project.site).insight.notFound({ days: DAYS });
    return { project: head, rows, reason: null };
  } catch (error) {
    if (error instanceof SiteNotConnected) return { project: head, rows: [], reason: error.detail };
    if (error instanceof SiteApiError && error.status === 501) return { project: head, rows: [], reason: "This site does not report its 404s to Carrel yet." };
    console.error(JSON.stringify({ notFound: "report-failed", error: String(error) }));
    return { project: head, rows: [], reason: "The site did not answer, so its 404s cannot be listed. Try again in a moment." };
  }
}

export default function ProjectNotFound({ loaderData }: Route.ComponentProps) {
  const { project, rows, reason } = loaderData;

  return (
    <div className="app-page">
      <PageHead title={project.name} lead={`Paths on ${project.site} that answered 404 in the last ${DAYS} days, and who linked to them.`} />

      <ProjectTabs slug={project.slug} current="not-found" mentions={project.mentions} />

      {reason ? (
        <Banner tone="warn" title="The 404 report is not available">
          {reason}
        </Banner>
      ) : (
        <Panel title="404s" count={rows.length} src={`Last ${DAYS} days`} flush>
          {rows.length === 0 ? (
            <Empty kind="all-clear" flush title={<Status tone="ok">All clear</Status>}>
              No missing pages in the last {DAYS} days.
            </Empty>
          ) : (
            <RowList label="Missing paths, most hits first">
              {rows.map((row) => (
                <Row
                  key={row.path}
                  title={<code>{row.path}</code>}
                  detail={`Linked from: ${referrers(row.referrers)}`}
                  meta={`${row.hits} ${row.hits === 1 ? "hit" : "hits"}`}
                />
              ))}
            </RowList>
          )}
        </Panel>
      )}
    </div>
  );
}
