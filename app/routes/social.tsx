// Social (design section 5): the accounts and their switches, the posts waiting on Dustin, the ones
// the lint held, template posts to acknowledge, and the record of every post. The Owner's alone.
// There is no reply, message, follow or like anywhere here, because there is none in the code.

import { useState } from "react";
import { Form, useFetcher, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Disclosure } from "capsomer/react/disclosure";
import { Empty } from "capsomer/react/empty";
import { Check, Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Select } from "capsomer/react/select";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";

import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";
import { routineConfig } from "~/lib/social/routine.server";
import { createAccount, decidePost, setSwitches, socialOverview } from "~/lib/social/queue.server";
import { xCostMills } from "~/lib/social/platforms.server";

import type { Route } from "./+types/social";

export function meta() {
  return [{ title: "Social · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const { accounts, posts, runs } = await socialOverview(env.DB, viewer);
  const routine = routineConfig(env);
  return {
    accounts,
    projects: (await visibleProjects(env.DB, viewer)).map((p) => ({ id: p.id, name: p.name })),
    posts: posts.map(({ post, ...rest }) => ({ ...post, ...rest, lint: JSON.parse(post.lint) as string[], costMills: rest.platform === "x" ? xCostMills(post.text) : 0 })),
    runs,
    routine: "missing" in routine ? routine.missing : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = Number(form.get("id"));
  switch (intent) {
    case "add-account": {
      const project = Number(form.get("projectId"));
      return createAccount(env.DB, viewer, {
        key: String(form.get("key") ?? "").trim(),
        name: String(form.get("name") ?? ""),
        platform: form.get("platform") === "x" ? "x" : "bluesky",
        kind: form.get("kind") === "personal" ? "personal" : "brand",
        handle: String(form.get("handle") ?? ""),
        projectId: Number.isInteger(project) && project > 0 ? project : null,
      });
    }
    case "switches":
      return setSwitches(env.DB, viewer, id, {
        enabled: form.get("enabled") === "on",
        mode: form.get("mode") === "auto" ? "auto" : "approval",
        dailyCap: Number(form.get("dailyCap")),
        monthlyBudgetMills: Math.round(Number(form.get("monthlyBudget") || 0) * 1000),
        template: String(form.get("template") ?? ""),
        voiceGuide: String(form.get("voiceGuide") ?? ""),
      });
    case "approve":
    case "reject":
    case "by-hand":
    case "acknowledge":
      return decidePost(env.DB, viewer, id, { action: intent });
    case "edit":
      return decidePost(env.DB, viewer, id, { action: "edit", text: String(form.get("text") ?? "") });
    default:
      throw new Response("Bad request", { status: 400 });
  }
}

const STATUS: Record<string, string> = {
  drafted: "Drafted",
  held: "Held by the lint",
  awaiting: "Awaiting approval",
  queued: "Queued",
  sent: "Sent",
  "by-hand": "Posted by hand",
  failed: "Failed",
  rejected: "Rejected",
};

type Post = Route.ComponentProps["loaderData"]["posts"][number];

export default function Social({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, projects, posts, runs, routine } = loaderData;
  const fetcher = useFetcher();
  const busy = useNavigation().state !== "idle";
  const [rejecting, setRejecting] = useState<{ post: Post; opener: HTMLElement | null } | null>(null);
  const open = posts.filter((p) => p.status === "awaiting" || p.status === "held");
  const unseen = posts.filter((p) => p.source === "template" && p.status === "sent" && !p.acknowledgedAt);
  return (
    <div className="app-page">
      <PageHead title="Social" lead="Posts only announce pieces that went live. Carrel never replies or messages." />

      {actionData && "error" in actionData && actionData.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
      {routine ? (
        <Banner tone="warn" title="The drafting routine is not set up">
          {routine} A piece with no pre-drafted post gets the template.
        </Banner>
      ) : null}

      {unseen.length > 0 ? (
        <Panel title="Template posts that went out" count={unseen.length} flush>
          <RowList label="Template posts that went out">
            {unseen.map((p) => (
              <Row
                key={p.id}
                title={p.text}
                detail={<>Posted to {p.accountKey} from the template.</>}
                actions={
                  <Form method="post">
                    <input type="hidden" name="id" value={p.id} />
                    <Button type="submit" name="intent" value="acknowledge" size="sm">
                      Seen<span className="cap-sr-only"> post to {p.accountKey}</span>
                    </Button>
                  </Form>
                }
              />
            ))}
          </RowList>
        </Panel>
      ) : null}

      <Panel title="Waiting on you" count={open.length}>
        {open.length === 0 ? (
          <Empty kind="all-clear" flush title={<Status tone="ok">All clear</Status>}>
            Nothing is waiting.
          </Empty>
        ) : (
          <ul className="app-posts" role="list">
            {open.map((p) => (
              <li key={p.id} className="app-post">
                <p className="app-post-meta">
                  <strong>{p.accountKey}</strong>
                  <Pill variant="secondary">{STATUS[p.status]}</Pill>
                  <span className="cap-muted">
                    {p.source}
                    {p.title ? ` · for "${p.title}"` : ""}
                    {p.platform === "x" ? ` · $${(p.costMills / 1000).toFixed(3)} through the API` : ""}
                  </span>
                </p>
                {p.lint.length > 0 ? (
                  <ul className="app-lint" aria-label="What the lint held it for">
                    {p.lint.map((l) => (
                      <li key={l}>
                        <Status tone="warn">{l}</Status>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Form method="post" className="app-form">
                  <input type="hidden" name="id" value={p.id} />
                  <label className="cap-sr-only" htmlFor={`post-${p.id}`}>
                    Post text for {p.accountKey}
                  </label>
                  <textarea className="cap-input" id={`post-${p.id}`} name="text" defaultValue={p.text} rows={3} />
                  <div className="app-actions">
                    {p.status === "awaiting" ? (
                      <Button type="submit" name="intent" value="approve" variant="primary" pending={busy}>
                        Approve
                      </Button>
                    ) : null}
                    <Button type="submit" name="intent" value="edit" pending={busy}>
                      Save and lint again
                    </Button>
                    {p.kind === "personal" ? (
                      <Button type="submit" name="intent" value="by-hand" pending={busy}>
                        I copied it and posted it by hand
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      name="intent"
                      value="reject"
                      variant="danger"
                      onClick={(event) => {
                        event.preventDefault();
                        setRejecting({ post: p, opener: event.currentTarget });
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Accounts" count={accounts.length}>
        {accounts.length === 0 ? (
          <Empty kind="nothing-yet" flush title="No accounts yet">
            Add one below. It starts off, in approval mode.
          </Empty>
        ) : (
          <div className="app-accounts">
            {accounts.map((a) => (
              <Form key={a.id} method="post" className="app-account app-form" aria-labelledby={`account-${a.id}`}>
                <input type="hidden" name="id" value={a.id} />
                <h3 id={`account-${a.id}`}>
                  {a.name} <span className="cap-muted">{a.platform} · @{a.handle} · {a.kind}</span>
                </h3>
                <div className="app-fields">
                  <Check name="enabled" defaultChecked={a.enabled} label="On" />
                  <Field label="Mode">
                    <Select
                      name="mode"
                      defaultValue={a.mode}
                      disabled={a.kind === "personal"}
                      options={[
                        { value: "approval", label: "Approve each post" },
                        { value: "auto", label: "Automatic" },
                      ]}
                    />
                  </Field>
                  <Field label="Posts a day">
                    <input className="cap-input" name="dailyCap" type="number" min={0} max={20} defaultValue={a.dailyCap} />
                  </Field>
                  {a.platform === "x" ? (
                    <Field label="X budget a month, $">
                      <input className="cap-input" name="monthlyBudget" type="number" min={0} step="0.01" defaultValue={(a.monthlyBudgetMills / 1000).toFixed(2)} />
                    </Field>
                  ) : null}
                </div>
                <Field label={`Template, the last resort ({title}, {summary}, {link})`}>
                  <input className="cap-input" name="template" defaultValue={a.template} placeholder="New: {title}. {summary} {link}" />
                </Field>
                <Field label="Voice guide, for whoever drafts">
                  <textarea className="cap-input" name="voiceGuide" defaultValue={a.voiceGuide} rows={2} />
                </Field>
                <div className="app-actions">
                  <Button type="submit" name="intent" value="switches" pending={busy}>
                    Save {a.key}
                  </Button>
                </div>
              </Form>
            ))}
          </div>
        )}
        <Disclosure summary="Add an account" defaultOpen={actionData !== undefined && "error" in actionData && Boolean(actionData.error)}>
          <Form method="post" className="app-form">
            <div className="app-fields">
              <Field label="Key" required>
                <input className="cap-input" name="key" required placeholder="germomics-bluesky" autoComplete="off" />
              </Field>
              <Field label="Name" required>
                <input className="cap-input" name="name" required placeholder="Germomics" autoComplete="off" />
              </Field>
              <Field label="Handle" required>
                <input className="cap-input" name="handle" required placeholder="germomics.bsky.social" autoComplete="off" />
              </Field>
              <Field label="Platform">
                <Select
                  name="platform"
                  options={[
                    { value: "bluesky", label: "Bluesky" },
                    { value: "x", label: "X" },
                  ]}
                />
              </Field>
              <Field label="Kind">
                <Select
                  name="kind"
                  options={[
                    { value: "brand", label: "Brand (labeled automated)" },
                    { value: "personal", label: "Personal (every post approved)" },
                  ]}
                />
              </Field>
              <Field label="Announces">
                <Select name="projectId" options={[{ value: "", label: "(no project yet)" }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))]} />
              </Field>
            </div>
            <p className="cap-muted app-note">It starts off, in approval mode.</p>
            <div className="app-actions">
              <Button type="submit" name="intent" value="add-account" variant="primary" pending={busy}>
                Add
              </Button>
            </div>
          </Form>
        </Disclosure>
      </Panel>

      <Panel title="Every post" count={posts.length} flush>
        {posts.length === 0 ? (
          <Empty kind="nothing-yet" flush title="No posts yet">
            Posts appear here once a piece goes live.
          </Empty>
        ) : (
          <div className="cap-table-wrap" role="region" aria-labelledby="record-caption" tabIndex={0}>
            <table className="cap-table">
              <caption id="record-caption" className="cap-sr-only">
                Every post
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Post</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.accountKey}</td>
                    <th scope="row">
                      <span className="app-post-text">{p.text}</span>
                      <span className="cap-table-aside">
                        {p.source} by {p.createdBy}
                        {p.error ? ` · ${p.error}` : ""}
                      </span>
                    </th>
                    <td>
                      <Pill variant={p.status === "failed" ? "destructive" : p.status === "sent" || p.status === "by-hand" ? "outline" : "secondary"}>{STATUS[p.status]}</Pill>
                      {p.sentAt ? <span className="cap-table-aside">{p.sentAt.slice(0, 16).replace("T", " ")}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {runs.length > 0 ? (
        <Panel title="Drafting routine runs" count={runs.length} flush>
          <RowList label="Drafting routine runs">
            {runs.map((r) => (
              <Row
                key={r.id}
                status={r.status === "failed" ? <Status tone="crit">Failed</Status> : <Status tone="ok">Fired</Status>}
                title={`${r.kind} run, ${(JSON.parse(r.events) as number[]).length} items`}
                detail={r.error ?? undefined}
                meta={<Time at={r.requestedAt} />}
                actions={
                  r.sessionUrl ? (
                    <a className="cap-btn" data-size="sm" href={r.sessionUrl} target="_blank" rel="noreferrer">
                      Session<span className="cap-sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : undefined
                }
              />
            ))}
          </RowList>
        </Panel>
      ) : null}

      <ConfirmDialog
        open={rejecting !== null}
        title="Reject this post?"
        lead="It will not be posted, and it cannot be brought back. A new draft can still be written."
        body={rejecting ? [rejecting.post.text] : []}
        action="Reject post"
        returnTo={rejecting?.opener}
        perform={async () => {
          if (!rejecting) return;
          await fetcher.submit({ intent: "reject", id: String(rejecting.post.id) }, { method: "post" });
        }}
        onClose={() => setRejecting(null)}
      />
    </div>
  );
}
