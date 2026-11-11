// The people page (Owner only): who is in Carrel, their role on each project as one grid of selects
// that save on change, and adding (in dialogs), sharing and disabling. Every change goes through app/lib/people-admin.server.ts, which checks the Owner.
//
// Carrel decides what a person may do once they are in; Cloudflare Access decides whether they get
// in at all. With CAPSID_AGENT_KEY set, every change to a role or to disabled is synced to Desk's
// Access group through Capsid (access-sync.server.ts, docs/coauthors.md), and the page says whether
// Access is in step. Without it, after an add the page says where the same email must also be
// allowed by hand. The dashboard paths are from Cloudflare's docs as read on 2026-09-27: developers.cloudflare.com/workers/
// configuration/cloudflare-access/ (the Worker's Access tab offers only "Cloudflare account" and
// "Email domain"; anything more is edited in Zero Trust), .../cloudflare-one/access-controls/policies/
// policy-management/ (Zero Trust > Access controls > Policies), and .../cloudflare-one/integrations/
// identity-providers/one-time-pin/ (Zero Trust > Integrations > Identity providers).

import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useNavigate, useNavigation, useSearchParams } from "react-router";
import { Table } from "capsomer/react/table";
import { ButtonLink } from "capsomer/react/link";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Check, Field } from "capsomer/react/field";
import { useMessage } from "capsomer/react/message";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import {
  accessState,
  syncAccess,
  type AccessState,
  type SyncOutcome,
} from "~/lib/access-sync.server";
import { getEnv, getViewer } from "~/lib/context";
import {
  addAgent,
  addPerson,
  listPeople,
  PeopleRefusal,
  setDisabled,
  setProjectRole,
} from "~/lib/people-admin.server";
import { useHydrated } from "~/lib/hydrated";
import { isMemberRole } from "~/lib/roles";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/people";

export function meta() {
  return [{ title: "People · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const [listed, access] = await Promise.all([
    listPeople(env.DB, getViewer(context)),
    accessState(env),
  ]);
  return { ...listed, access };
}

type ActionResult =
  | { ok: true; intent: string; added?: string; agent?: string; access?: SyncOutcome }
  | { ok: false; intent: string; message: string };

export async function action({ request, context }: Route.ActionArgs): Promise<ActionResult> {
  const env = getEnv(context);
  const db = env.DB;
  const viewer = getViewer(context);
  const form = await readForm(request);
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
      case "add-agent": {
        const added = await addAgent(db, viewer, {
          name: String(form.get("agent") ?? ""),
          label: String(form.get("label") ?? ""),
        });
        return { ok: true, intent, agent: added.email };
      }
      case "role": {
        const role = String(form.get("role") ?? "");
        const change = await setProjectRole(
          db,
          viewer,
          personId,
          Number(form.get("project")),
          isMemberRole(role) ? role : null,
        );
        return { ok: true, intent, access: await syncAccess(env, change) };
      }
      // A row's Save with no script: every project's role for one person, set one by one.
      case "roles": {
        const removed: string[] = [];
        for (const [key, value] of form) {
          if (!key.startsWith("role-")) continue;
          const role = String(value);
          const change = await setProjectRole(
            db,
            viewer,
            personId,
            Number(key.slice("role-".length)),
            isMemberRole(role) ? role : null,
          );
          removed.push(...change.removed);
        }
        return { ok: true, intent: "role", access: await syncAccess(env, { removed }) };
      }
      case "disable":
      case "enable": {
        const change = await setDisabled(db, viewer, personId, intent === "disable");
        return { ok: true, intent, access: await syncAccess(env, change) };
      }
      // Retry: the same whole list again, after Cloudflare or the setup is fixed.
      case "sync":
        if (!viewer.isOwner || viewer.isReviewer) throw new Response("Not found", { status: 404 });
        return { ok: true, intent, access: await syncAccess(env, { removed: [] }) };
      default:
        throw new Response("Bad request", { status: 400 });
    }
  } catch (error) {
    if (error instanceof PeopleRefusal) return { ok: false, intent, message: error.message };
    throw error;
  }
}

type Person = Route.ComponentProps["loaderData"]["people"][number];

/** Whether Desk's Access group holds who Carrel says it should, from the last sync. Nothing when the sync is not set up. */
function AccessStatus({ access, busy }: { access: AccessState; busy: boolean }) {
  if (!access.configured) return null;
  const last = access.last;
  const retry = (
    <Form method="post">
      <Button type="submit" name="intent" value="sync" size="sm" pending={busy}>
        {last ? "Retry" : "Sync now"}
      </Button>
    </Form>
  );
  if (last?.ok) {
    return (
      <Banner tone="ok" title="Cloudflare Access is in step">
        Desk lets in each person with a role on a project, and no one else but you. Synced{" "}
        <Time at={last.syncedAt} />.
      </Banner>
    );
  }
  if (last) {
    return (
      <Alert tone="warn" title="Waiting for Cloudflare" action={retry}>
        {last.refusal} Tried <Time at={last.syncedAt} />. Carrel's own roles already apply; only
        getting past Access waits.
      </Alert>
    );
  }
  return (
    <Banner tone="info" title="Cloudflare Access has not been synced yet" actions={retry}>
      Every change to a role syncs it. Sync now to bring Access in step with the people below.
    </Banner>
  );
}

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
    if (fetcher.state !== "idle" || !data?.ok || data.intent !== "disable" || said.current === data)
      return;
    said.current = data;
    say(`${name} is disabled. They are refused at both doors on their next request.`, {
      undo: () =>
        fetcher.submit({ intent: "enable", person: String(person.id) }, { method: "post" }),
      undone: `${name} is enabled again.`,
    });
  }, [fetcher, name, person.id, say]);
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="person" value={person.id} />
      <Button
        type="submit"
        name="intent"
        value={disabled ? "enable" : "disable"}
        size="sm"
        pending={fetcher.state !== "idle"}
      >
        {disabled ? "Enable" : "Disable"}
        <span className="cap-sr-only"> {name}</span>
      </Button>
    </fetcher.Form>
  );
}

type Project = Route.ComponentProps["loaderData"]["projects"][number];

const ROLE_LABEL: Record<string, string> = {
  "": "No access",
  reader: "Reader",
  editor: "Editor",
  author: "Author",
};

/** One person's row: a role select per project that saves on change. With no script, the row's
 * Save button posts every project's role at once. */
function PersonRow({
  person,
  projects,
  onSaved,
}: {
  person: Person;
  projects: Project[];
  onSaved: (text: string) => void;
}) {
  const fetcher = useFetcher<ActionResult>();
  const hydrated = useHydrated();
  const name = person.name || person.email;
  const kind = person.isOwner
    ? "Owner"
    : person.email.startsWith("agent:")
      ? "Agent (AI)"
      : person.isReviewer
        ? "Reviewer (AI)"
        : null;
  const formId = `roles-${person.id}`;
  return (
    <tr>
      <th scope="row">
        <span className="app-role-person">{name}</span>
        {person.name ? (
          <span className="cap-muted app-outliner-chapter">{person.email}</span>
        ) : null}
        <span className="app-role-pills">
          {kind ? <Pill variant="outline">{kind}</Pill> : null}
          {person.disabledAt ? (
            <Pill variant="secondary">Disabled {person.disabledAt.slice(0, 10)}</Pill>
          ) : null}
        </span>
        {person.isOwner ? null : (
          <span className="app-actions app-role-actions">
            {hydrated ? null : (
              <Button type="submit" form={formId} size="sm">
                Save<span className="cap-sr-only"> roles for {name}</span>
              </Button>
            )}
            <AccessButton person={person} />
          </span>
        )}
        {person.isOwner ? null : (
          <form id={formId} method="post" hidden>
            <input type="hidden" name="intent" value="roles" />
            <input type="hidden" name="person" value={person.id} />
          </form>
        )}
      </th>
      {person.isOwner ? (
        <td colSpan={projects.length} className="cap-muted">
          Owner of every project.
        </td>
      ) : (
        projects.map((project) => {
          const role = person.roles.find((r) => r.projectId === project.id)?.role ?? "";
          return (
            <td key={project.id}>
              <Select
                form={formId}
                name={`role-${project.id}`}
                size="sm"
                aria-label={`${name} on ${project.name}`}
                defaultValue={role}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  void fetcher
                    .submit(
                      {
                        intent: "role",
                        person: String(person.id),
                        project: String(project.id),
                        role: value,
                      },
                      { method: "post" },
                    )
                    .then(() =>
                      onSaved(`Saved: ${name} on ${project.name}, ${ROLE_LABEL[value]}.`),
                    );
                }}
                options={[
                  { value: "", label: "No access" },
                  { value: "reader", label: "Reader" },
                  // Reviewers read and flag only: Editor and Author are not offered, and the server refuses them anyway.
                  ...(person.isReviewer ? [] : [{ value: "editor", label: "Editor" }]),
                  // An Author publishes their own posts: a person on a site's project, never an agent.
                  ...(person.isReviewer ||
                  person.email.startsWith("agent:") ||
                  project.kind !== "site"
                    ? []
                    : [{ value: "author", label: "Author" }]),
                ]}
              />
            </td>
          );
        })
      )}
    </tr>
  );
}

/** Adding a person or an AI agent: dialogs opened from the head (?add=person, ?add=agent), so a link
 * opens one; before the page's script runs, the same forms show as panels. */
function AddDialogs({ adding, busy }: { adding: string | null; busy: boolean }) {
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const person = (
    <Form method="post" action="/people" className="app-form">
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
          <Check
            type="radio"
            name="reviewer"
            value="no"
            defaultChecked
            label="A person, given a role on each project under Access"
          />
          <Check
            type="radio"
            name="reviewer"
            value="yes"
            label="A reviewer: another company's AI agent, which reads and flags only, through the AI door"
          />
        </div>
      </fieldset>
      <div className="app-actions">
        <Button type="submit" name="intent" value="add" variant="primary" pending={busy}>
          Add
        </Button>
      </div>
    </Form>
  );
  const agent = (
    <Form method="post" action="/people" className="app-form">
      <p className="cap-muted app-note">
        For an agent that cannot sign in with OAuth. It reaches the AI door with its own key, never
        as you.
      </p>
      <div className="app-fields">
        <Field label="Agent name" required help="Lower case, such as grok.">
          <input
            className="cap-input"
            type="text"
            name="agent"
            required
            autoComplete="off"
            pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}"
          />
        </Field>
        <Field label="Label">
          <input className="cap-input" type="text" name="label" autoComplete="off" />
        </Field>
      </div>
      <div className="app-actions">
        <Button type="submit" name="intent" value="add-agent" variant="primary" pending={busy}>
          Add agent
        </Button>
      </div>
    </Form>
  );
  if (!hydrated)
    return (
      <>
        <Panel title="Add a person">{person}</Panel>
        <Panel title="Add an AI agent">{agent}</Panel>
      </>
    );
  const close = (open: boolean) => {
    if (!open) void navigate("/people", { replace: true, preventScrollReset: true });
  };
  return (
    <>
      <Dialog open={adding === "person"} onOpenChange={close} aria-labelledby="add-person-title">
        <DialogHeader>
          <DialogTitle id="add-person-title">Add a person</DialogTitle>
        </DialogHeader>
        <DialogBody>{person}</DialogBody>
      </Dialog>
      <Dialog open={adding === "agent"} onOpenChange={close} aria-labelledby="add-agent-title">
        <DialogHeader>
          <DialogTitle id="add-agent-title">Add an AI agent</DialogTitle>
        </DialogHeader>
        <DialogBody>{agent}</DialogBody>
      </Dialog>
    </>
  );
}

export default function People({ loaderData, actionData }: Route.ComponentProps) {
  const { people, projects, access } = loaderData;
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const adding = params.get("add");
  const [saved, setSaved] = useState("");

  return (
    <div className="app-page">
      <PageHead
        title="People"
        lead="Who is in Carrel, and what each person may do on each project. Only the Owner sees this page."
        actions={
          <>
            <ButtonLink to="/people?add=agent" preventScrollReset>
              Add an AI agent
            </ButtonLink>
            <ButtonLink
              to="/people?add=person"

              variant="primary"
              preventScrollReset
            >
              Add a person
            </ButtonLink>
          </>
        }
      />

      {actionData && !actionData.ok ? (
        <Alert tone="crit" title="Nothing changed">
          {actionData.message}
        </Alert>
      ) : null}

      <AccessStatus access={access} busy={busy} />

      {actionData?.ok && actionData.agent ? (
        <Alert tone="warn" title={`Added ${actionData.agent}. It has no key and no role yet.`}>
          <div className="app-steps">
            <p>
              An agent reaches the AI door with a key, a Worker secret named <code>AGENT_KEY_</code>{" "}
              and the agent's name in capitals. Carrel never shows or stores the key. The key says
              which agent is knocking and grants nothing: what the agent may do is the role you set
              for it below, and it can never publish.
            </p>
            <ol>
              <li>
                Set the Worker secret from a file, in the carrel folder:{" "}
                <code>
                  Get-Content &lt;key file&gt; -Raw | npx wrangler secret put AGENT_KEY_
                  {actionData.agent.slice("agent:".length).toUpperCase()}
                </code>
                .
              </li>
              <li>
                Set the agent's role on each project it may use, below. Editor lets it save AI
                drafts, and it flags and previews as a Reader does.
              </li>
            </ol>
          </div>
        </Alert>
      ) : actionData?.ok && actionData.added && access.configured ? (
        <Alert tone="info" title={`Added ${actionData.added}. Share a project with them below.`}>
          <p>
            Cloudflare Access lets them into Desk once they hold a role on a project, and keeps them
            out again when they are disabled or have no role left. Access emails a login code only
            if <em>One-time PIN</em> is set up (Zero Trust &gt; Integrations &gt; Identity
            providers); without it, a person with no Cloudflare account cannot sign in. The AI door
            (carrel-mcp.dustinedwards.info) is still allowed by hand, in its policy{" "}
            <em>Carrel people</em>.
          </p>
        </Alert>
      ) : actionData?.ok && actionData.added ? (
        <Alert tone="warn" title={`Added ${actionData.added}. They cannot sign in yet.`}>
          <div className="app-steps">
            <p>
              Carrel decides what a person may do once they are in. Cloudflare Access decides
              whether they get in at all, and Carrel does not manage it. Allow the same email in
              both places:
            </p>
            <ol>
              <li>
                <strong>Desk</strong> (desk.dustinedwards.info). In Workers &amp; Pages &gt; carrel
                &gt; Access, the policy today allows only <em>Cloudflare account</em> members, and
                that tab offers only <em>Cloudflare account</em> and <em>Email domain</em>. For one
                person who is not an account member, add an Include rule with the <em>Emails</em>{" "}
                selector and their address: in Zero Trust &gt; Access controls &gt; Policies (a
                reusable policy added to the Worker's application), or on the Worker's application
                itself in Zero Trust &gt; Access controls &gt; Applications.
              </li>
              <li>
                <strong>The AI door</strong> (carrel-mcp.dustinedwards.info), only if they will use
                Carrel from Claude: in Zero Trust &gt; Access controls &gt; Policies, configure the
                policy <em>Carrel people</em> (used by the Access for SaaS application{" "}
                <em>Carrel AI Door</em>) and add the address to its Emails rule.
              </li>
            </ol>
            <p>
              <strong>Signing in without a Cloudflare account:</strong> Access emails a login code
              only if <em>One-time PIN</em> is set up, in Zero Trust &gt; Integrations &gt; Identity
              providers &gt; Add new identity provider &gt; One-time PIN. Without it, a person with
              no Cloudflare account has no way to sign in.
            </p>
            <p>
              Then share a project with them below. A person with no role on a project sees nothing
              of it.
            </p>
          </div>
        </Alert>
      ) : actionData?.ok && actionData.intent === "role" ? (
        <Banner tone="ok">Saved.</Banner>
      ) : null}

      <Panel
        title="Access"
        count={people.length}
        src="A disabled person is refused at both doors on their next request, whatever Access says. Their roles are kept."
        flush
      >
        <p className="cap-muted app-note cap-panel-pad">
          A Reader reads and comments. An Editor also writes and saves drafts. An Author on a site's
          project also publishes, schedules and unpublishes the posts they wrote in Carrel. Only the
          Owner publishes anyone else's post, sends anything else outside Carrel and manages people.
          A role saves as soon as you change it.
        </p>
        <p className="cap-sr-only" role="status">
          {saved}
        </p>
        <Table
          caption="People, and their role on each project"
          captionHidden
          className="app-roles-wrap"
          tableClassName="app-roles"
        >
          <thead>
            <tr>
              <th scope="col">Person</th>
              {projects.map((project) => (
                <th scope="col" key={project.id}>
                  {project.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <PersonRow key={person.id} person={person} projects={projects} onSaved={setSaved} />
            ))}
          </tbody>
        </Table>
      </Panel>

      <AddDialogs adding={adding} busy={busy} />
    </div>
  );
}
