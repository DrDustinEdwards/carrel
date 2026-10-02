// Every flag on a site project, in one list (open first): from the checks, from AI sessions and from
// reviewers, including flags on items the site does not have, which no editor page can reach (a proof
// item, a post since deleted). Anyone who can read the project sees them; only the Owner dismisses,
// through the same function as the editor's Dismiss, so a dismissal is recorded the same way.

import { useState, type ReactNode } from "react";
import { Form, Link, useFetcher } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";
import { ProjectTabs } from "~/components/project-tabs";

import { dismissItemFinding, projectFlags } from "~/lib/ai.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/project.flags";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Flags · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name },
    canDismiss: can(project.role, "publish"),
    flags: await projectFlags(env.DB, project),
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  // The Owner's alone, as in the editor: a dismissed flag no longer holds publish.
  const project = await requireSiteProject(env.DB, viewer, params.project, "publish");
  const form = await request.formData();
  if (form.get("intent") !== "dismiss") throw new Response("Bad request", { status: 400 });
  const id = Number(form.get("flag"));
  const item = String(form.get("item") ?? "");
  if (!Number.isInteger(id) || !item) throw new Response("Bad request", { status: 400 });
  await dismissItemFinding(env.DB, project, viewer, item, id);
  return { dismissed: id };
}

/** Who raised it: a check by name, or the credit an AI session or reviewer put on its message. */
function source(check: string): string {
  if (check === "review") return "Reviewer";
  if (check === "ai") return "AI session";
  return `Check: ${check}`;
}

type Flag = Route.ComponentProps["loaderData"]["flags"][number];

export default function ProjectFlags({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canDismiss, flags } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const [target, setTarget] = useState<{ flag: Flag; opener: HTMLElement | null } | null>(null);
  const open = flags.filter((f) => f.status === "open").length;
  const dismissed = fetcher.data?.dismissed ?? actionData?.dismissed;
  const link = ({ href, children }: { href: string; children: ReactNode }) => <Link to={href}>{children}</Link>;

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`${open} open of ${flags.length} flags on ${project.site}. An open flag holds publish until the text is fixed or the Owner dismisses it.`}
      />

      <ProjectTabs slug={project.slug} current="flags" />

      {dismissed ? <Banner tone="ok">Dismissed flag {dismissed}.</Banner> : null}

      <Panel title="Flags" count={open} src={`${open} open, ${flags.length - open} dismissed`} flush>
        {flags.length === 0 ? (
          <Empty kind="all-clear" flush title={<Status tone="ok">All clear</Status>}>
            No flags on this project.
          </Empty>
        ) : (
          <RowList label="Flags on this project">
            {flags.map((flag) => {
              const isOpen = flag.status === "open";
              return (
                <Row
                  key={flag.id}
                  status={isOpen ? <Status tone="warn">Open</Status> : <Pill variant="secondary">Dismissed</Pill>}
                  title={flag.message}
                  href={flag.onSite ? `/p/${project.slug}/e/${encodeURIComponent(flag.itemId)}` : undefined}
                  renderLink={link}
                  detail={
                    <>
                      {source(flag.check)} on {flag.onSite ? flag.title || flag.itemId : flag.itemId}
                      {flag.onSite ? null : ". Not on the site: no editor page reaches this flag"}
                      {flag.excerpt ? (
                        <>
                          {" "}
                          <q>{flag.excerpt}</q>
                        </>
                      ) : null}
                    </>
                  }
                  meta={<Time at={flag.createdAt} />}
                  actions={
                    isOpen && canDismiss ? (
                      <Form method="post">
                        <input type="hidden" name="flag" value={flag.id} />
                        <input type="hidden" name="item" value={flag.itemId} />
                        <Button
                          type="submit"
                          name="intent"
                          value="dismiss"
                          size="sm"
                          onClick={(event) => {
                            event.preventDefault();
                            setTarget({ flag, opener: event.currentTarget });
                          }}
                        >
                          Dismiss<span className="cap-sr-only"> flag: {flag.message}</span>
                        </Button>
                      </Form>
                    ) : undefined
                  }
                />
              );
            })}
          </RowList>
        )}
      </Panel>

      <ConfirmDialog
        open={target !== null}
        title="Dismiss this flag?"
        lead="A dismissed flag no longer holds publish, and it cannot be reopened."
        body={target ? [target.flag.message] : []}
        action="Dismiss flag"
        returnTo={target?.opener}
        perform={async () => {
          if (!target) return;
          await fetcher.submit({ intent: "dismiss", flag: String(target.flag.id), item: target.flag.itemId }, { method: "post" });
        }}
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
