// Docs activity: every change an AI made in a Google Doc through Carrel, newest first:
// which AI (and the model it said), what it did and why, in which Doc, and the id any AI takes to undo it. The Doc
// itself holds the suggestions and comments to accept or reject; this is the record beside it. Owner only, like the
// manuscripts.

import { ButtonLink } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import { DataTable } from "capsomer/react/table";
import { Time } from "capsomer/react/time";

import { getEnv, getViewer } from "~/lib/context";
import { docActivity } from "~/lib/google/docs.server";

import type { Route } from "./+types/manuscripts-activity";

export function meta() {
  return [{ title: "Docs activity · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  return { changes: await docActivity(getEnv(context), getViewer(context)) };
}

const WHAT: Record<string, string> = {
  suggest: "Suggested",
  comment: "Commented",
  reply: "Replied",
  resolve: "Resolved a comment",
  reopen: "Reopened a comment",
  write: "Wrote directly",
  accept: "Accepted suggestions",
  reject: "Rejected suggestions",
  withdraw: "Withdrew its suggestions",
  undo: "Took a change back",
};

/** A comment or a post on a thread is one thing; the rest count their edits or suggestions. */
const THREAD = new Set(["comment", "reply", "resolve", "reopen"]);

export default function DocsActivity({ loaderData }: Route.ComponentProps) {
  const { changes } = loaderData;
  return (
    <div className="cap-admin-page">
      <PageHead
        title="Docs activity"
        actions={<ButtonLink to="/manuscripts">Manuscripts</ButtonLink>}
      />
      <Panel title="Changes" count={changes.length} flush>
        {changes.length === 0 ? (
          <Empty kind="nothing-yet" flush title="No AI has changed a Doc yet" />
        ) : (
          <DataTable
            caption="Changes AIs made in Google Docs"
            captionHidden
            rows={changes}
            rowKey={(c) => String(c.id)}
            empty="No AI has changed a Doc yet"
            columns={[
              { key: "when", header: "When", cell: (c) => <Time at={c.createdAt} /> },
              {
                key: "ai",
                header: "AI",
                cell: (c) => (
                  <>
                    {c.client}
                    {c.model ? <span className="cap-table-aside">{c.model}</span> : null}
                  </>
                ),
              },
              {
                key: "what",
                header: "What",
                cell: (c) => (
                  <>
                    {WHAT[c.kind] ?? c.kind}
                    {THREAD.has(c.kind) ? "" : ` (${c.changes})`}
                    <span className="cap-table-aside">{c.id}</span>
                    {c.reason ? <span className="cap-table-aside">{c.reason}</span> : null}
                    {c.labeled ? null : <Status tone="warn">No label in the Doc</Status>}
                    {c.undoneAt ? <Status tone="nodata">Taken back</Status> : null}
                  </>
                ),
              },
              {
                key: "doc",
                header: "Doc",
                drop: 1,
                cell: (c) =>
                  c.link ? (
                    <a href={c.link} target="_blank" rel="noreferrer">
                      {c.name}
                      <span className="cap-sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    "A Doc no longer in the index"
                  ),
              },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
