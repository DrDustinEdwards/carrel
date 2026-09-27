// Social (design section 5): the accounts and their switches, the posts waiting on Dustin, the ones
// the lint held, template posts to acknowledge, and the record of every post. The Owner's alone.
// There is no reply, message, follow or like anywhere here, because there is none in the code.

import { Form, Link } from "react-router";

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

export default function Social({ loaderData, actionData }: Route.ComponentProps) {
  const { accounts, projects, posts, runs, routine } = loaderData;
  const open = posts.filter((p) => p.status === "awaiting" || p.status === "held");
  const unseen = posts.filter((p) => p.source === "template" && p.status === "sent" && !p.acknowledgedAt);
  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>Social</h1>
        <p className="muted">Posts only announce pieces that went live. Carrel never replies or messages.</p>
      </header>

      {actionData && "error" in actionData && actionData.error ? (
        <p className="alarm" role="alert">
          {actionData.error}
        </p>
      ) : null}
      {routine ? (
        <p className="notice" role="status">
          The drafting routine is not set up ({routine}), so a piece with no pre-drafted post gets the template.
        </p>
      ) : null}

      {unseen.length > 0 ? (
        <section aria-labelledby="templates-heading">
          <h2 id="templates-heading">Template posts that went out</h2>
          <ul className="post-list">
            {unseen.map((p) => (
              <li key={p.id}>
                <p>
                  <strong>{p.accountKey}</strong>: {p.text}
                </p>
                <Form method="post">
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" name="intent" value="acknowledge" className="btn-ghost">
                    Seen
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="open-heading">
        <h2 id="open-heading">Waiting on you</h2>
        {open.length === 0 ? <p className="muted">Nothing is waiting.</p> : null}
        <ul className="post-list">
          {open.map((p) => (
            <li key={p.id}>
              <p className="muted">
                {p.accountKey} · {STATUS[p.status]} · {p.source}
                {p.title ? ` · for "${p.title}"` : ""}
                {p.platform === "x" ? ` · $${(p.costMills / 1000).toFixed(3)} through the API` : ""}
              </p>
              {p.lint.length > 0 ? (
                <ul className="flag-list">
                  {p.lint.map((l) => (
                    <li key={l} className="flag-open">
                      {l}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Form method="post" className="stack">
                <input type="hidden" name="id" value={p.id} />
                <label className="field">
                  <span className="sr-only">Post text</span>
                  <textarea name="text" defaultValue={p.text} rows={3} />
                </label>
                <div className="actions">
                  <button type="submit" name="intent" value="edit" className="btn-ghost">
                    Save and lint again
                  </button>
                  {p.status === "awaiting" ? (
                    <button type="submit" name="intent" value="approve" className="btn">
                      Approve
                    </button>
                  ) : null}
                  {p.kind === "personal" ? (
                    <button type="submit" name="intent" value="by-hand" className="btn-ghost">
                      I copied it and posted it by hand
                    </button>
                  ) : null}
                  <button type="submit" name="intent" value="reject" className="btn-danger">
                    Reject
                  </button>
                </div>
              </Form>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading">Accounts</h2>
        {accounts.length === 0 ? <p className="muted">No accounts yet.</p> : null}
        {accounts.map((a) => (
          <Form key={a.id} method="post" className="account-card">
            <input type="hidden" name="id" value={a.id} />
            <h3>
              {a.name} <span className="muted">{a.platform} · @{a.handle} · {a.kind}</span>
            </h3>
            <div className="actions">
              <label className="field-inline">
                <input type="checkbox" name="enabled" defaultChecked={a.enabled} /> <span>On</span>
              </label>
              <label className="field-inline">
                <span>Mode</span>
                <select name="mode" defaultValue={a.mode} disabled={a.kind === "personal"}>
                  <option value="approval">Approve each post</option>
                  <option value="auto">Automatic</option>
                </select>
              </label>
              <label className="field-inline">
                <span>Posts a day</span>
                <input name="dailyCap" type="number" min={0} max={20} defaultValue={a.dailyCap} />
              </label>
              {a.platform === "x" ? (
                <label className="field-inline">
                  <span>X budget a month, $</span>
                  <input name="monthlyBudget" type="number" min={0} step="0.01" defaultValue={(a.monthlyBudgetMills / 1000).toFixed(2)} />
                </label>
              ) : null}
            </div>
            <label className="field">
              <span>Template, the last resort ({"{title}"}, {"{summary}"}, {"{link}"})</span>
              <input name="template" defaultValue={a.template} placeholder="New: {title}. {summary} {link}" />
            </label>
            <label className="field">
              <span>Voice guide, for whoever drafts</span>
              <textarea name="voiceGuide" defaultValue={a.voiceGuide} rows={2} />
            </label>
            <button type="submit" name="intent" value="switches" className="btn-ghost">
              Save {a.key}
            </button>
          </Form>
        ))}
        <Form method="post" className="account-card">
          <h3>Add an account</h3>
          <div className="actions">
            <label className="field-inline">
              <span>Key</span>
              <input name="key" required placeholder="germomics-bluesky" />
            </label>
            <label className="field-inline">
              <span>Name</span>
              <input name="name" required placeholder="Germomics" />
            </label>
            <label className="field-inline">
              <span>Platform</span>
              <select name="platform">
                <option value="bluesky">Bluesky</option>
                <option value="x">X</option>
              </select>
            </label>
            <label className="field-inline">
              <span>Kind</span>
              <select name="kind">
                <option value="brand">Brand (labeled automated)</option>
                <option value="personal">Personal (every post approved)</option>
              </select>
            </label>
            <label className="field-inline">
              <span>Handle</span>
              <input name="handle" required placeholder="germomics.bsky.social" />
            </label>
            <label className="field-inline">
              <span>Announces</span>
              <select name="projectId">
                <option value="">(no project yet)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">It starts off, in approval mode.</p>
          <button type="submit" name="intent" value="add-account" className="btn">
            Add
          </button>
        </Form>
      </section>

      <section aria-labelledby="record-heading">
        <h2 id="record-heading">Every post</h2>
        <table className="items">
          <caption className="sr-only">Every post</caption>
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
                <td>
                  {p.text}
                  <span className="muted item-id">
                    {p.source} by {p.createdBy}
                    {p.error ? ` · ${p.error}` : ""}
                  </span>
                </td>
                <td>
                  {STATUS[p.status]}
                  {p.sentAt ? <span className="muted item-id">{p.sentAt.slice(0, 16).replace("T", " ")}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {runs.length > 0 ? (
        <section aria-labelledby="runs-heading">
          <h2 id="runs-heading">Drafting routine runs</h2>
          <ul className="post-list">
            {runs.map((r) => (
              <li key={r.id}>
                {r.requestedAt.slice(0, 16).replace("T", " ")} · {r.kind} · {r.status} · {(JSON.parse(r.events) as number[]).length} items
                {r.sessionUrl ? (
                  <>
                    {" "}
                    ·{" "}
                    <a href={r.sessionUrl} target="_blank" rel="noreferrer">
                      session
                    </a>
                  </>
                ) : null}
                {r.error ? <span className="muted"> · {r.error}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
