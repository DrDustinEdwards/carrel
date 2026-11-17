// The outliner (ruling, build step 1), a view of a book's Manuscript tab: every scene of the book as
// one table, in reading order, with the header keys a writer plans by (status, summary, point of view,
// words against the target or limit), filtered by status chips that are links. It reads Carrel's index
// and stores nothing of its own. The status list itself is edited on the book's Settings tab.

import { LinkChips } from "capsomer/react/chips";
import { Table } from "capsomer/react/table";
import { Link, routerRenderLink } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import { BookHead } from "~/components/book-head";
import { ColorLabelPill } from "capsomer/react/label-color-list";

import { bookHead, listFiles, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";
import { chapterOf, readingOrder, titleFromSegment } from "~/lib/novels/layout";
import { can } from "~/lib/roles";
import { statusList } from "~/lib/writing.server";
import { labelFor } from "capsomer/behavior/label-color-list";

import type { Route } from "./+types/book.outliner";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Outliner · ${data.head.name} · Carrel` : "Carrel" }];
}

/** The filter's values besides the labels themselves. */
const NONE = "none";
const OTHER = "other";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireBookProject(env.DB, getViewer(context), params.project, "read");
  const [files, status, head] = await Promise.all([
    listFiles(env.DB, project),
    statusList(env.DB, project),
    bookHead(env, project),
  ]);
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
    const key = !r.status
      ? NONE
      : (labelFor(status.labels, r.status)?.label.toLowerCase() ?? OTHER);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    head,
    canEdit: can(project.role, "edit"),
    labels: status.labels,
    rows: shown,
    total: rows.length,
    counts: Object.fromEntries(counts),
    filter: wanted,
  };
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

export default function Outliner({ loaderData }: Route.ComponentProps) {
  const { head, canEdit, labels, rows, total, counts, filter } = loaderData;
  const base = `/b/${head.slug}`;
  const chips = [
    { value: "", label: "Every status", count: total },
    ...labels.map((l) => ({
      value: l.label.toLowerCase(),
      label: l.label,
      count: counts[l.label.toLowerCase()] ?? 0,
    })),
    { value: NONE, label: "No status", count: counts[NONE] ?? 0 },
    ...(counts[OTHER] ? [{ value: OTHER, label: "Not on the list", count: counts[OTHER] }] : []),
  ];
  const filterName = chips.find((o) => o.value === filter)?.label ?? filter;

  return (
    <div className="cap-admin-page">
      <BookHead book={head} section="manuscript" view="outliner" />

      <div className="app-chip-filter">
        <LinkChips
          label="Status"
          showLabel
          chips={chips.map((c) => ({
            href: c.value
              ? `${base}/outliner?status=${encodeURIComponent(c.value)}`
              : `${base}/outliner`,
            label: c.label,
            count: c.count,
            current: c.value === filter,
          }))}
          renderLink={routerRenderLink}
        />
        {canEdit ? (
          <Link to={`${base}/settings`} className="app-chip-edit">
            Edit the statuses
          </Link>
        ) : null}
      </div>

      <Panel title="Scenes" count={rows.length} flush>
        <p className="cap-sr-only" role="status">
          {filter
            ? `${rows.length} of ${total} scenes with the status ${filterName}.`
            : `${total} scenes.`}
        </p>
        {total === 0 ? (
          <Empty kind="nothing-yet" flush title="No scenes in the index yet">
            Start a chapter in the List view, or refresh from Git.
          </Empty>
        ) : rows.length === 0 ? (
          <Empty kind="no-match" flush title={`No scenes have the status ${filterName}.`}>
            <Link to={base + "/outliner"}>Show every scene</Link>
          </Empty>
        ) : (
          <Table
            caption={<>Scenes in reading order{filter ? `, with the status ${filterName}` : ""}</>}
            captionHidden
          >
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
                  <td>
                    {r.status ? (
                      <ColorLabelPill
                        labels={labels}
                        value={r.status}
                        unknownNote=" (not on the status list)"
                      />
                    ) : (
                      <span className="cap-muted">None</span>
                    )}
                  </td>
                  <td data-drop="1">{r.summary || <span className="cap-muted">None</span>}</td>
                  <td data-drop="2">{r.pov}</td>
                  <td data-num>{measure(r.words, r.target, r.limit)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
