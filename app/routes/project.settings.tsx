// A site's Share and connection tab: whether Desk can reach the site, what Desk's index holds of it and
// when it last read it, and (for the Owner) sharing the site's project with a coauthor.

import { Link } from "capsomer/react/link";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { count, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ProjectTabs } from "~/components/project-tabs";
import { SharePanel } from "~/components/share-panel";

import { siteItems } from "~/db/schema";
import { getEnv, getViewer } from "~/lib/context";
import { shareFromForm } from "~/lib/people-admin.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteConnection, siteEntry } from "~/lib/sites.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/project.settings";
import { plural } from "@drdustinedwards/site-helpers/text";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Share and connection · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const connection = siteConnection(env, project.site);
  const index = await drizzle(env.DB)
    .select({ n: count(), last: max(siteItems.syncedAt) })
    .from(siteItems)
    .where(eq(siteItems.projectId, project.id))
    .get();
  return {
    project: {
      slug: project.slug,
      name: project.name,
      site: siteEntry(project.site).name,
      canShare: can(project.role, "manage"),
    },
    connection: {
      state: connection.state,
      origin: connection.state === "connected" ? connection.origin : null,
    },
    indexed: index?.n ?? 0,
    lastRead: index?.last ?? null,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  if (form.get("intent") !== "share") throw new Response("Bad request", { status: 400 });
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  return { share: await shareFromForm(env, viewer, project.id, form) };
}

const STATE = {
  connected: <Status tone="ok">Connected</Status>,
  "not-connected": <Status tone="warn">Not connected: the site's key is not set yet</Status>,
  misconfigured: <Status tone="crit">Set up wrong: the health check says what to fix</Status>,
} as const;

export default function SiteSettings({ loaderData }: Route.ComponentProps) {
  const { project, connection, indexed, lastRead } = loaderData;
  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`How Desk reaches ${project.site}, and who shares it.`}
      />
      <ProjectTabs slug={project.slug} current="settings" />

      <Panel title="Connection">
        <dl className="cap-summary-list">
          <div>
            <dt>Site</dt>
            <dd>
              {connection.origin ? (
                <a href={connection.origin} target="_blank" rel="noreferrer">
                  {connection.origin}
                  <span className="cap-sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                project.site
              )}
            </dd>
          </div>
          <div>
            <dt>Desk's key</dt>
            <dd>{STATE[connection.state]}</dd>
          </div>
          <div>
            <dt>In Desk's index</dt>
            <dd>
              {plural(indexed, "post", undefined, { grouped: true })} and pages
              {lastRead ? (
                <>
                  , last read <Time at={lastRead} />. Desk reads every site again every 15 minutes;
                  a save in Desk shows at once.
                </>
              ) : (
                ", not read yet."
              )}
            </dd>
          </div>
          <div>
            <dt>Everything on it</dt>
            <dd>
              <Link to={`/writing?site=${project.slug}`}>Its posts in Writing</Link>
            </dd>
          </div>
        </dl>
      </Panel>

      {project.canShare ? <SharePanel site /> : null}
    </div>
  );
}
