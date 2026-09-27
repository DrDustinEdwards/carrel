// Every flag on a site project, in one list (open first): from the checks, from AI sessions and from
// reviewers, including flags on items the site does not have, which no editor page can reach (a proof
// item, a post since deleted). Anyone who can read the project sees them; only the Owner dismisses,
// through the same function as the editor's Dismiss, so a dismissal is recorded the same way.

import { Form, Link, useNavigation } from "react-router";

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

export default function ProjectFlags({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canDismiss, flags } = loaderData;
  const busy = useNavigation().state !== "idle";
  const open = flags.filter((f) => f.status === "open").length;

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link> / <Link to={`/p/${project.slug}`}>{project.name}</Link>
        </p>
        <h1>Flags</h1>
        <p className="muted">
          {open} open of {flags.length} on {project.site}. An open flag holds publish until the text is fixed or the Owner dismisses it.
        </p>
      </header>

      {actionData?.dismissed ? (
        <p className="notice" role="status">
          Dismissed flag {actionData.dismissed}.
        </p>
      ) : null}

      {flags.length === 0 ? (
        <p className="muted">No flags on this project.</p>
      ) : (
        <table className="items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">From</th>
              <th scope="col">Flag</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <tr key={flag.id} className={flag.status === "open" ? "flag-open" : "finding-dismissed"}>
                <td>
                  {flag.onSite ? <Link to={`/p/${project.slug}/e/${encodeURIComponent(flag.itemId)}`}>{flag.title || flag.itemId}</Link> : flag.itemId}
                  <span className="item-id">{flag.onSite ? flag.itemId : "Not on the site: no editor page reaches this flag."}</span>
                </td>
                <td>{source(flag.check)}</td>
                <td>
                  {/* The credit ("from Claude Code", "from Grok Build") is part of the message, as the flag was written. */}
                  {flag.message}
                  {flag.excerpt ? <blockquote className="muted">{flag.excerpt}</blockquote> : null}
                  <span className="item-id">{flag.createdAt.slice(0, 10)}</span>
                </td>
                <td>
                  {flag.status === "open" ? (
                    canDismiss ? (
                      <Form method="post">
                        <input type="hidden" name="flag" value={flag.id} />
                        <input type="hidden" name="item" value={flag.itemId} />
                        <button type="submit" name="intent" value="dismiss" className="btn-ghost" disabled={busy}>
                          Dismiss
                        </button>
                      </Form>
                    ) : (
                      "Open"
                    )
                  ) : (
                    "Dismissed"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
