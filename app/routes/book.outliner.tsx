// The outliner (ruling, build step 1): every scene of the book as one table, in reading order, with
// the header keys a writer plans by (status, summary, point of view, words against the target or
// limit), filterable by status. It reads Carrel's index and stores nothing of its own. Below it, the
// project's status list, which anyone who may write here can edit.

import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Disclosure } from "capsomer/react/disclosure";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";
import { Status } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";
import { StatusLabelPill } from "~/components/writing/status-label";

import { listFiles, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { chapterOf, readingOrder, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { saveStatusList, statusList } from "~/lib/writing.server";
import { COLOR_NAMES, labelFor, MAX_LABELS } from "~/lib/writing/status";

import type { Route } from "./+types/book.outliner";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Outliner · ${data.project.name} · Carrel` : "Carrel" }];
}

/** The filter's values besides the labels themselves. */
const NONE = "none";
const OTHER = "other";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [files, status] = await Promise.all([listFiles(env.DB, project), statusList(env.DB, project)]);
  const rows = readingOrder(files).map((f) => {
    const header = f.meta.kind === "scene" ? f.meta.header : null;
    const chapter = chapterOf(f.path)!;
    return {
      path: f.path,
      chapter: titleFromSegment(chapter),
      name: titleFromSegment(f.path.split("/")[2]!.replace(/\.md$/, "")),
      // Index rows from before these keys carry none of them until the file is next read.
      status: header?.status ?? "",
      summary: header?.summary ?? "",
      pov: header?.pov ?? "",
      target: header?.target ?? null,
      limit: header?.limit ?? null,
      words: f.words,
    };
  });

  const wanted = (new URL(request.url).searchParams.get("status") ?? "").trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (!wanted) return true;
    if (wanted === NONE) return !r.status;
    if (wanted === OTHER) return Boolean(r.status) && !labelFor(status.labels, r.status);
    return r.status.toLowerCase() === wanted;
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = !r.status ? NONE : (labelFor(status.labels, r.status)?.label.toLowerCase() ?? OTHER);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    project: { slug: project.slug, name: project.name },
    canEdit: can(project.role, "edit"),
    labels: status.labels,
    edited: status.edited,
    rows: shown,
    total: rows.length,
    counts: Object.fromEntries(counts),
    filter: wanted,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "edit");
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "labels") throw new Response("Bad request", { status: 400 });
  const labels = form.getAll("label").map(String);
  const colors = form.getAll("color").map(String);
  const saved = await saveStatusList(env.DB, project, labels.map((label, i) => ({ label, color: colors[i] ?? "" })));
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error };
}

function measure(words: number, target: number | null, limit: number | null) {
  const n = (v: number) => v.toLocaleString("en-US");
  if (limit !== null) {
    return words > limit ? (
      <>
        {n(words)} of {n(limit)} <Status tone="warn">Over the limit</Status>
      </>
    ) : (
      `${n(words)} of ${n(limit)} allowed`
    );
  }
  if (target !== null) {
    return words >= target ? (
      <>
        {n(words)} of {n(target)} <Status tone="ok">Reached</Status>
      </>
    ) : (
      `${n(words)} of ${n(target)}`
    );
  }
  return n(words);
}

export default function Outliner({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canEdit, labels, edited, rows, total, counts, filter } = loaderData;
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formData?.get("intent") === "labels";
  const base = `/b/${project.slug}`;
  const options = [
    { value: "", label: `Every status (${total})` },
    ...labels.map((l) => ({ value: l.label.toLowerCase(), label: `${l.label} (${counts[l.label.toLowerCase()] ?? 0})` })),
    { value: NONE, label: `No status (${counts[NONE] ?? 0})` },
    ...(counts[OTHER] ? [{ value: OTHER, label: `Not on the list (${counts[OTHER]})` }] : []),
  ];
  const filterName = options.find((o) => o.value === filter)?.label.replace(/ \(\d+\)$/, "") ?? filter;
  // Room to add labels: two empty rows under the list, up to the limit.
  const editRows = [...labels, ...Array.from({ length: Math.max(0, Math.min(2, MAX_LABELS - labels.length)) }, () => ({ label: "", color: 0 }))];

  return (
    <div className="app-page">
      <PageHead
        crumbs={[{ label: project.name, href: base }, { label: "Outliner" }]}
        title="Outliner"
        lead="Every scene in reading order, with the header keys you plan by. Change a scene's status, summary or target in its header."
      />

      <Form method="get" className="app-inline-form app-filter" aria-label="Filter by status">
        <Field label="Status">
          <Select name="status" defaultValue={params.get("status") ?? ""} options={options} />
        </Field>
        <Button type="submit">Filter</Button>
      </Form>

      <Panel title="Scenes" count={rows.length} flush>
        <p className="cap-sr-only" role="status">
          {filter ? `${rows.length} of ${total} scenes with the status ${filterName}.` : `${total} scenes.`}
        </p>
        {total === 0 ? (
          <Empty kind="nothing-yet" flush title="No scenes in the index yet">
            Start a chapter on the book page, or refresh from Git.
          </Empty>
        ) : rows.length === 0 ? (
          <Empty kind="no-match" flush title={`No scenes have the status ${filterName}.`}>
            <Link to={base + "/outliner"}>Show every scene</Link>
          </Empty>
        ) : (
          <div className="cap-table-wrap" role="region" aria-labelledby="outliner-caption" tabIndex={0}>
            <table className="cap-table">
              <caption id="outliner-caption" className="cap-sr-only">
                Scenes in reading order{filter ? `, with the status ${filterName}` : ""}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Scene</th>
                  <th scope="col">Status</th>
                  <th scope="col" data-drop="1">
                    Summary
                  </th>
                  <th scope="col" data-drop="2">
                    Point of view
                  </th>
                  <th scope="col" data-num>
                    Words
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.path}>
                    <th scope="row">
                      <Link className="cap-table-open" to={`${base}/f/${r.path}`}>
                        {r.name}
                      </Link>
                      <span className="cap-muted app-outliner-chapter">{r.chapter}</span>
                    </th>
                    <td>{r.status ? <StatusLabelPill labels={labels} status={r.status} /> : <span className="cap-muted">None</span>}</td>
                    <td data-drop="1">{r.summary || <span className="cap-muted">None</span>}</td>
                    <td data-drop="2">{r.pov}</td>
                    <td data-num>{measure(r.words, r.target, r.limit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Status list" count={labels.length} src={edited ? "This book's own" : "The starting list for books"}>
        <div className="app-stack" data-tight>
          <ul className="app-label-list" aria-label="Statuses, in order">
            {labels.map((l) => (
              <li key={l.label}>
                <StatusLabelPill labels={labels} status={l.label} />
              </li>
            ))}
          </ul>
          <p className="cap-muted app-note">A scene takes one with status: in its header. A status not on the list still shows, as written.</p>
          {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : actionData?.saved ? <Banner tone="ok">The status list is saved.</Banner> : null}
          {canEdit ? (
            <Disclosure summary="Edit the list" defaultOpen={Boolean(actionData?.error)}>
              <Form method="post" className="app-stack" data-tight>
                <input type="hidden" name="intent" value="labels" />
                <p className="cap-muted app-note">In order. Clear a label to remove it; renaming one does not change the scenes that carry the old word.</p>
                <ol className="app-label-edit">
                  {editRows.map((l, i) => (
                    <li key={i} className="app-inline-form">
                      <Field label={`Label ${i + 1}`}>
                        <input className="cap-input" name="label" defaultValue={l.label} maxLength={40} autoComplete="off" />
                      </Field>
                      <Field label={`Color ${i + 1}`}>
                        <Select name="color" defaultValue={String(l.color || (i % 8) + 1)} options={COLOR_NAMES.map((c, k) => ({ value: String(k + 1), label: c }))} />
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
    </div>
  );
}
