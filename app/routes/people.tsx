// The people page (Owner only): who is in Carrel, their role on each project, and adding, sharing and
// disabling. Every change goes through app/lib/people-admin.server.ts, which checks the Owner.
//
// Carrel decides what a person may do once they are in; Cloudflare Access decides whether they get
// in at all. So after an add the page says where the same email must also be allowed. The dashboard
// paths are from Cloudflare's docs as read on 2026-09-27: developers.cloudflare.com/workers/
// configuration/cloudflare-access/ (the Worker's Access tab offers only "Cloudflare account" and
// "Email domain"; anything more is edited in Zero Trust), .../cloudflare-one/access-controls/policies/
// policy-management/ (Zero Trust > Access controls > Policies), and .../cloudflare-one/integrations/
// identity-providers/one-time-pin/ (Zero Trust > Integrations > Identity providers).

import { Form, Link, useNavigation } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { addPerson, listPeople, PeopleRefusal, setDisabled, setProjectRole } from "~/lib/people-admin.server";

import type { Route } from "./+types/people";

export function meta() {
  return [{ title: "People · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return listPeople(getEnv(context).DB, getViewer(context));
}

type ActionResult = { ok: true; intent: string; added?: string } | { ok: false; intent: string; message: string };

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const db = getEnv(context).DB;
  const viewer = getViewer(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const personId = Number(form.get("person"));
  try {
    switch (intent) {
      case "add": {
        const added = await addPerson(db, viewer, {
          email: String(form.get("email") ?? ""),
          name: String(form.get("name") ?? ""),
          reviewer: form.get("reviewer") === "yes",
        });
        return { ok: true, intent, added: added.email };
      }
      case "role": {
        const role = String(form.get("role") ?? "");
        await setProjectRole(db, viewer, personId, Number(form.get("project")), role === "reader" || role === "editor" ? role : null);
        return { ok: true, intent };
      }
      case "disable":
      case "enable":
        await setDisabled(db, viewer, personId, intent === "disable");
        return { ok: true, intent };
      default:
        throw new Response("Bad request", { status: 400 });
    }
  } catch (error) {
    if (error instanceof PeopleRefusal) return { ok: false, intent, message: error.message };
    throw error;
  }
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people, projects } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>People</h1>
        <p className="muted">Who is in Carrel, and what each person may do on each project. Only the Owner sees this page.</p>
      </header>

      {actionData && !actionData.ok ? (
        <p className="alarm" role="alert">
          Nothing changed. {actionData.message}
        </p>
      ) : null}

      {actionData?.ok && actionData.added ? (
        <section className="notice access-steps" role="status" aria-labelledby="access-heading">
          <h2 id="access-heading">Added {actionData.added}. They cannot sign in yet.</h2>
          <p>
            Carrel decides what a person may do once they are in. Cloudflare Access decides whether they get in at all, and Carrel does not manage it. Allow the same
            email in both places:
          </p>
          <ol>
            <li>
              <strong>Carrel's pages</strong> (carrel.dustinedwards.info). In Workers &amp; Pages &gt; carrel &gt; Access, the policy today allows only{" "}
              <em>Cloudflare account</em> members, and that tab offers only <em>Cloudflare account</em> and <em>Email domain</em>. For one person who is not an account
              member, add an Include rule with the <em>Emails</em> selector and their address: in Zero Trust &gt; Access controls &gt; Policies (a reusable policy added
              to the Worker's application), or on the Worker's application itself in Zero Trust &gt; Access controls &gt; Applications.
            </li>
            <li>
              <strong>The AI door</strong> (carrel-mcp.dustinedwards.info), only if they will use Carrel from Claude: in Zero Trust &gt; Access controls &gt; Policies,
              configure the policy <em>Carrel people</em> (used by the Access for SaaS application <em>Carrel AI Door</em>) and add the address to its Emails rule.
            </li>
          </ol>
          <p>
            <strong>Signing in without a Cloudflare account:</strong> Access emails a login code only if <em>One-time PIN</em> is set up, in Zero Trust &gt; Integrations
            &gt; Identity providers &gt; Add new identity provider &gt; One-time PIN. Without it, a person with no Cloudflare account has no way to sign in.
          </p>
          <p className="muted">Then share a project with them below. A person with no role on a project sees nothing of it.</p>
        </section>
      ) : actionData?.ok ? (
        <p className="notice" role="status">
          Saved.
        </p>
      ) : null}

      <section aria-labelledby="people-heading">
        <h2 id="people-heading">People</h2>
        <table className="items">
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Kind</th>
              {projects.map((p) => (
                <th key={p.id} scope="col">
                  {p.name}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">Enable or disable</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const kind = person.isOwner ? "Owner" : person.isReviewer ? "Reviewer (AI)" : "Person";
              return (
                <tr key={person.id} data-disabled={person.disabledAt ? "" : undefined}>
                  <td>
                    {person.name || person.email}
                    <span className="item-id">{person.email}</span>
                    {person.disabledAt ? <span className="muted"> Disabled {person.disabledAt.slice(0, 10)}</span> : null}
                  </td>
                  <td>{kind}</td>
                  {projects.map((project) => {
                    const role = person.roles.find((r) => r.projectId === project.id)?.role ?? "";
                    if (person.isOwner) {
                      return <td key={project.id}>Owner</td>;
                    }
                    return (
                      <td key={project.id}>
                        <Form method="post" className="inline-form">
                          <input type="hidden" name="intent" value="role" />
                          <input type="hidden" name="person" value={person.id} />
                          <input type="hidden" name="project" value={project.id} />
                          <label className="sr-only" htmlFor={`role-${person.id}-${project.id}`}>
                            {person.email} on {project.name}
                          </label>
                          <select id={`role-${person.id}-${project.id}`} name="role" defaultValue={role}>
                            <option value="">No access</option>
                            <option value="reader">Reader</option>
                            {/* Reviewers read and flag only: Editor is not offered, and the server refuses it anyway. */}
                            {person.isReviewer ? null : <option value="editor">Editor</option>}
                          </select>
                          <button type="submit" className="btn-ghost" disabled={busy}>
                            Set
                          </button>
                        </Form>
                      </td>
                    );
                  })}
                  <td>
                    {person.isOwner ? null : (
                      <Form method="post">
                        <input type="hidden" name="person" value={person.id} />
                        {person.disabledAt ? (
                          <button type="submit" name="intent" value="enable" className="btn-ghost" disabled={busy}>
                            Enable
                          </button>
                        ) : (
                          <button type="submit" name="intent" value="disable" className="btn-danger" disabled={busy}>
                            Disable
                          </button>
                        )}
                      </Form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">A disabled person is refused at both doors on their next request, whatever Access says. Their roles are kept for if they are enabled again.</p>
      </section>

      <section aria-labelledby="add-heading">
        <h2 id="add-heading">Add a person</h2>
        <Form method="post" className="stack">
          <label className="field">
            <span>Email</span>
            <input type="email" name="email" required autoComplete="off" />
          </label>
          <label className="field">
            <span>Name</span>
            <input type="text" name="name" autoComplete="off" />
          </label>
          <fieldset className="field">
            <legend>Kind</legend>
            <label>
              <input type="radio" name="reviewer" value="no" defaultChecked /> A person, who reads, and edits where you share a project as Editor
            </label>
            <label>
              <input type="radio" name="reviewer" value="yes" /> A reviewer (another company's AI agent), who reads and flags only, through the AI door
            </label>
          </fieldset>
          <p>
            <button type="submit" name="intent" value="add" className="btn" disabled={busy}>
              Add
            </button>
          </p>
        </Form>
      </section>
    </main>
  );
}
