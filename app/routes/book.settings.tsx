// A book's Settings tab: the scene status list the outliner and the corkboard use, sharing the book
// with a coauthor, the authorship record, and where the book lives in Git.

import { Form, useNavigation } from "react-router";
import { Link } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Disclosure } from "capsomer/react/disclosure";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";

import { BookHead } from "~/components/book-head";
import { SharePanel } from "~/components/share-panel";
import { StatusLabelPill } from "~/components/writing/status-label";

import { bookHead, bookRepo, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { shareFromForm } from "~/lib/people-admin.server";
import { can } from "~/lib/roles";
import { saveStatusList, statusList } from "~/lib/writing.server";
import { COLOR_NAMES, MAX_LABELS } from "~/lib/writing/status";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.settings";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Settings · ${data.head.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [status, head] = await Promise.all([statusList(env.DB, project), bookHead(env, project)]);
  return {
    head,
    canEdit: can(project.role, "edit"),
    canShare: can(project.role, "manage"),
    connectionDetail: bookRepo(env).detail,
    labels: status.labels,
    edited: status.edited,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  if (intent === "share") {
    const project = await requireBookProject(env.DB, viewer, params.project, "read");
    return { share: await shareFromForm(env, viewer, project.id, form) };
  }
  if (intent !== "labels") throw new Response("Bad request", { status: 400 });
  const project = await requireBookProject(env.DB, viewer, params.project, "edit");
  const labels = form.getAll("label").map(String);
  const colors = form.getAll("color").map(String);
  const saved = await saveStatusList(
    env.DB,
    project,
    labels.map((label, i) => ({ label, color: colors[i] ?? "" })),
  );
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error };
}

export default function BookSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canEdit, canShare, connectionDetail, labels, edited } = loaderData;
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formData?.get("intent") === "labels";
  const base = `/b/${head.slug}`;
  const result = actionData && "saved" in actionData ? actionData : null;
  // Room to add labels: two empty rows under the list, up to the limit.
  const editRows = [
    ...labels,
    ...Array.from({ length: Math.max(0, Math.min(2, MAX_LABELS - labels.length)) }, () => ({
      label: "",
      color: 0,
    })),
  ];

  return (
    <div className="app-page">
      <BookHead book={head} section="settings" />

      <div className="app-split" data-aside data-even>
        <Panel
          title="Scene statuses"
          count={labels.length}
          src={edited ? "This book's own" : "The starting list for books"}
        >
          <div className="app-stack" data-tight>
            <ul className="app-label-list" aria-label="Statuses, in order">
              {labels.map((l) => (
                <li key={l.label}>
                  <StatusLabelPill labels={labels} status={l.label} />
                </li>
              ))}
            </ul>
            <p className="cap-muted app-note">
              A scene takes one with status: in its header. A status not on the list still shows, as
              written.
            </p>
            {result?.error ? (
              <Alert tone="crit">{result.error}</Alert>
            ) : result?.saved ? (
              <Banner tone="ok">The status list is saved.</Banner>
            ) : null}
            {canEdit ? (
              <Disclosure summary="Edit the list" defaultOpen={Boolean(result?.error)}>
                <Form method="post" className="app-stack" data-tight>
                  <input type="hidden" name="intent" value="labels" />
                  <p className="cap-muted app-note">
                    In order. Clear a label to remove it; renaming one does not change the scenes
                    that carry the old word.
                  </p>
                  <ol className="app-label-edit">
                    {editRows.map((l, i) => (
                      <li key={i} className="app-inline-form">
                        <Field label={`Label ${i + 1}`}>
                          <input
                            className="cap-input"
                            name="label"
                            defaultValue={l.label}
                            maxLength={40}
                            autoComplete="off"
                          />
                        </Field>
                        <Field label={`Color ${i + 1}`}>
                          <Select
                            name="color"
                            defaultValue={String(l.color || (i % 8) + 1)}
                            options={COLOR_NAMES.map((c, k) => ({
                              value: String(k + 1),
                              label: c,
                            }))}
                          />
                        </Field>
                      </li>
                    ))}
                  </ol>
                  <div className="app-actions">
                    <Button type="submit" pending={saving}>
                      Save the list
                    </Button>
                  </div>
                </Form>
              </Disclosure>
            ) : null}
          </div>
        </Panel>

        <Panel title="The book">
          <dl className="cap-summary-list">
            <div>
              <dt>Folder</dt>
              <dd>
                <span className="cap-mono">{head.book}/</span>
              </dd>
            </div>
            <div>
              <dt>Git</dt>
              <dd>{head.connected ? "Connected" : connectionDetail}</dd>
            </div>
            <div>
              <dt>Title page</dt>
              <dd>
                <Link to={`${base}/f/book.md`}>book.md</Link>
              </dd>
            </div>
            <div>
              <dt>Authorship record</dt>
              <dd>
                <Link to={`${base}/authorship`} reloadDocument>
                  Download the record
                </Link>
              </dd>
            </div>
            <div>
              <dt>People</dt>
              <dd>
                <Link to="/people">Every person and role</Link>
              </dd>
            </div>
          </dl>
        </Panel>
      </div>

      {canShare ? <SharePanel site={false} /> : null}
    </div>
  );
}
