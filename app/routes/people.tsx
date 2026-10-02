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

import { useEffect, useRef } from "react";
import { Form, useFetcher, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Check, Field } from "capsomer/react/field";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Pill } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";

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

type Person = Route.ComponentProps["loaderData"]["people"][number];

/**
 * Disable and Enable are one control that stays mounted across the reload that follows, so it can say
 * the result. Disabling is reversible on the server (Enable), so it happens at once and offers Undo.
 */
function AccessButton({ person }: { person: Person }) {
  const fetcher = useFetcher<ActionResult>();
  const { say } = useMessage();
  const said = useRef<unknown>(null);
  const name = person.name || person.email;
  const disabled = Boolean(person.disabledAt);
  useEffect(() => {
    const data = fetcher.data;
    if (fetcher.state !== "idle" || !data?.ok || data.intent !== "disable" || said.current === data) return;
    said.current = data;
    say(`${name} is disabled. They are refused at both doors on their next request.`, {
      undo: () => fetcher.submit({ intent: "enable", person: String(person.id) }, { method: "post" }),
      undone: `${name} is enabled again.`,
    });
  }, [fetcher, name, person.id, say]);
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="person" value={person.id} />
      <Button type="submit" name="intent" value={disabled ? "enable" : "disable"} size="sm" pending={fetcher.state !== "idle"}>
        {disabled ? "Enable" : "Disable"}
        <span className="cap-sr-only"> {name}</span>
      </Button>
    </fetcher.Form>
  );
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people, projects } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="app-page">
      <PageHead title="People" lead="Who is in Carrel, and what each person may do on each project. Only the Owner sees this page." />

      {actionData && !actionData.ok ? <Alert tone="crit" title="Nothing changed">{actionData.message}</Alert> : null}

      {actionData?.ok && actionData.added ? (
        <Alert tone="warn" title={`Added ${actionData.added}. They cannot sign in yet.`}>
          <div className="app-steps">
            <p>
              Carrel decides what a person may do once they are in. Cloudflare Access decides whether they get in at all, and Carrel does not manage it. Allow the same email in
              both places:
            </p>
            <ol>
              <li>
                <strong>Carrel's pages</strong> (carrel.dustinedwards.info). In Workers &amp; Pages &gt; carrel &gt; Access, the policy today allows only{" "}
                <em>Cloudflare account</em> members, and that tab offers only <em>Cloudflare account</em> and <em>Email domain</em>. For one person who is not an account
                member, add an Include rule with the <em>Emails</em> selector and their address: in Zero Trust &gt; Access controls &gt; Policies (a reusable policy added to
                the Worker's application), or on the Worker's application itself in Zero Trust &gt; Access controls &gt; Applications.
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
            <p>Then share a project with them below. A person with no role on a project sees nothing of it.</p>
          </div>
        </Alert>
      ) : actionData?.ok && actionData.intent === "role" ? (
        <Banner tone="ok">Saved.</Banner>
      ) : null}

      <Panel title="Access" count={people.length} src="A disabled person is refused at both doors on their next request, whatever Access says. Their roles are kept." flush>
        <div className="cap-table-wrap" role="region" aria-labelledby="people-caption" tabIndex={0}>
          <table className="cap-table">
            <caption id="people-caption" className="cap-sr-only">
              People and their role on each project
            </caption>
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
                  <span className="cap-sr-only">Enable or disable</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const kind = person.isOwner ? "Owner" : person.isReviewer ? "Reviewer (AI)" : "Person";
                return (
                  <tr key={person.id}>
                    <th scope="row">
                      {person.name || person.email}
                      <span className="cap-table-aside">{person.email}</span>
                      {person.disabledAt ? <Pill variant="secondary">Disabled {person.disabledAt.slice(0, 10)}</Pill> : null}
                    </th>
                    <td>
                      <Pill variant="outline">{kind}</Pill>
                    </td>
                    {projects.map((project) => {
                      const role = person.roles.find((r) => r.projectId === project.id)?.role ?? "";
                      if (person.isOwner) return <td key={project.id}>Owner</td>;
                      const id = `role-${person.id}-${project.id}`;
                      return (
                        <td key={project.id}>
                          <Form method="post" className="app-inline">
                            <input type="hidden" name="intent" value="role" />
                            <input type="hidden" name="person" value={person.id} />
                            <input type="hidden" name="project" value={project.id} />
                            <label className="cap-sr-only" htmlFor={id}>
                              {person.email} on {project.name}
                            </label>
                            <Select
                              id={id}
                              name="role"
                              size="sm"
                              defaultValue={role}
                              options={[
                                { value: "", label: "No access" },
                                { value: "reader", label: "Reader" },
                                // Reviewers read and flag only: Editor is not offered, and the server refuses it anyway.
                                ...(person.isReviewer ? [] : [{ value: "editor", label: "Editor" }]),
                              ]}
                            />
                            <Button type="submit" size="sm" pending={busy}>
                              Set<span className="cap-sr-only"> role for {person.email} on {project.name}</span>
                            </Button>
                          </Form>
                        </td>
                      );
                    })}
                    <td>
                      {person.isOwner ? null : <AccessButton person={person} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Add a person">
        <Form method="post" className="app-form">
          <div className="app-fields">
            <Field label="Email" required>
              <input className="cap-input" type="email" name="email" required autoComplete="off" />
            </Field>
            <Field label="Name">
              <input className="cap-input" type="text" name="name" autoComplete="off" />
            </Field>
          </div>
          <fieldset className="cap-field">
            <legend className="cap-field-label">Kind</legend>
            <div className="cap-field-options">
              <Check type="radio" name="reviewer" value="no" defaultChecked label="A person, who reads, and edits where you share a project as Editor" />
              <Check type="radio" name="reviewer" value="yes" label="A reviewer (another company's AI agent), who reads and flags only, through the AI door" />
            </div>
          </fieldset>
          <div className="app-actions">
            <Button type="submit" name="intent" value="add" variant="primary" pending={busy}>
              Add
            </Button>
          </div>
        </Form>
      </Panel>
    </div>
  );
}
