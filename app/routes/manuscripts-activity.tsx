// Docs activity (the Docs plan, slice 2): every change an AI made in a Google Doc through Carrel, newest first: which AI
// (and the model it said), what it did and why, in which Doc. The Doc itself holds the suggestions and comments to
// accept or reject; this is the record beside it. Owner only, like the manuscripts.

import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
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
};

export default function DocsActivity({ loaderData }: Route.ComponentProps) {
  const { changes } = loaderData;
  return (
    <div className="app-page">
      <PageHead
        title="Docs activity"
        lead="What AIs changed in your Google Docs through Carrel. Accept or reject suggestions in the Doc itself."
        actions={
          <Link to="/manuscripts" className="cap-btn">
            Manuscripts
          </Link>
        }
      />
      <Panel title="Changes" count={changes.length} src="Carrel's record" flush>
        {changes.length === 0 ? (
          <Empty kind="nothing-yet" flush title="No AI has changed a Doc yet">
            A suggestion or comment an AI makes through Carrel shows here.
          </Empty>
        ) : (
          <div
            className="cap-table-wrap"
            role="region"
            aria-labelledby="docs-activity-caption"
            tabIndex={0}
          >
            <table className="cap-table">
              <caption id="docs-activity-caption" className="cap-sr-only">
                Changes AIs made in Google Docs
              </caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">AI</th>
                  <th scope="col">What</th>
                  <th scope="col" data-drop="1">
                    Doc
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">
                      <Time at={c.createdAt} />
                    </th>
                    <td>
                      {c.client}
                      {c.model ? <span className="cap-table-aside">{c.model}</span> : null}
                    </td>
                    <td>
                      {WHAT[c.mode] ?? c.mode}
                      {c.mode === "suggest" ? ` (${c.changes})` : ""}
                      {c.reason ? <span className="cap-table-aside">{c.reason}</span> : null}
                      {c.labeled ? null : <Status tone="warn">No label in the Doc</Status>}
                    </td>
                    <td data-drop="1">
                      {c.link ? (
                        <a href={c.link} target="_blank" rel="noreferrer">
                          {c.name}
                          <span className="cap-sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        "A Doc no longer in the index"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
