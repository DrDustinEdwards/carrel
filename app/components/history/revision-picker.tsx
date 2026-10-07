// The revisions of one item, newest first: each opens its source, and any two can be picked and
// compared. A plain GET form, so it works as delivered: the picks travel as `v` in the address and
// the history page orders them. Read-only: nothing here changes the site.

import { Link } from "react-router";
import { Button } from "capsomer/react/button";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

export type RevisionRow = { version: string; at: string; author: string; message: string };

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

export function RevisionPicker({ revisions, historyPath, picked = [], label }: { revisions: RevisionRow[]; historyPath: string; picked?: string[]; label: string }) {
  const captionId = `${label.replace(/\W+/g, "-").toLowerCase()}-caption`;
  return (
    <form method="get" action={historyPath} className="app-stack" data-tight aria-label={label}>
      <div className="cap-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="cap-table">
          <caption id={captionId} className="cap-sr-only">
            {label}, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Compare</th>
              <th scope="col">Revision</th>
              <th scope="col">By</th>
              <th scope="col">Saved</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r, i) => (
              <tr key={r.version} data-state={picked.includes(r.version) ? "selected" : undefined}>
                <td>
                  <label className="cap-check">
                    <input type="checkbox" name="v" value={r.version} defaultChecked={picked.includes(r.version)} />
                    <span className="cap-sr-only">
                      Compare the revision from {utc(r.at)} by {r.author}
                    </span>
                  </label>
                </td>
                <th scope="row">
                  <Link className="cap-table-open" to={`${historyPath}?version=${encodeURIComponent(r.version)}`}>
                    {r.message || "No message"}
                    <span className="cap-sr-only">, open its source</span>
                  </Link>
                  {i === 0 ? <Pill tone="ok">Current</Pill> : null}
                </th>
                <td>{r.author}</td>
                <td>
                  <Time at={r.at} />
                  <span className="cap-table-aside">{utc(r.at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="app-actions">
        <Button type="submit" variant="primary">
          Compare the two picked
        </Button>
        <span className="cap-muted">Pick two revisions. The older is shown first.</span>
      </div>
    </form>
  );
}
