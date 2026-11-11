// The paths readers asked a site for that it does not have, from the 404s the site counts (site-api
// v0.16.0, GET /insight/not-found): most hits first over the last 7 or 30 days (?days=7; 30 by default), with the hosts that linked to
// each, so a broken link or a moved page can be fixed. Read only. Paths and hosts are what strangers
// sent, so they are drawn as text, never as links.

import { SiteApiError } from "@dustinedwards/site-api/client";
import { useSearchParams } from "react-router";
import { NotFoundReport } from "capsomer/react/not-found-report";
import { PageHead } from "capsomer/react/page-head";
import { windowOf } from "capsomer/behavior/not-found-report";

import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteClient, siteEntry, SiteNotConnected } from "~/lib/sites.server";

import type { Route } from "./+types/project.not-found";

/** The two windows the page offers: the last week, to see a link that just broke, and the last 30 days, the default. */
const WINDOWS = [7, 30];

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `404s · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const env = getEnv(context);
  const days = windowOf(new URL(request.url).searchParams.get("days"), WINDOWS);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const head = {
    slug: project.slug,
    name: project.name,
    site: siteEntry(project.site).name,
  };
  try {
    const { rows } = await siteClient(env, project.site).insight.notFound({ days });
    return { project: head, days, rows, reason: null };
  } catch (error) {
    if (error instanceof SiteNotConnected)
      return { project: head, days, rows: [], reason: error.detail };
    if (error instanceof SiteApiError && error.status === 501)
      return {
        project: head,
        days,
        rows: [],
        reason: "This site does not report its 404s to Carrel yet.",
      };
    console.error(JSON.stringify({ notFound: "report-failed", error: String(error) }));
    return {
      project: head,
      days,
      rows: [],
      reason: "The site did not answer, so its 404s cannot be listed. Try again in a moment.",
    };
  }
}

export default function ProjectNotFound({ loaderData }: Route.ComponentProps) {
  const { project, days, rows, reason } = loaderData;
  const [, setSearchParams] = useSearchParams();

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`Paths on ${project.site} that answered 404 in the last ${days} days, and who linked to them.`}
      />

      <ProjectTabs slug={project.slug} current="not-found" />

      <NotFoundReport
        rows={rows}
        days={days}
        windows={WINDOWS}
        onWindow={(d) => setSearchParams(d === 30 ? {} : { days: String(d) })}
        reason={reason ?? undefined}
      />
    </div>
  );
}
