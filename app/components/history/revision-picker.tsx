// The revisions of one item, newest first: each opens its source, and any two can be picked and
// compared. A plain GET form, so it works as delivered: the picks travel as `v` in the address and
// the history page orders them. Once two are ticked, a Compare bar holds to the bottom of the window.
// Read-only: nothing here changes the site.

import { useState } from "react";
import { Link } from "capsomer/react/link";
import { Button } from "capsomer/react/button";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

export type RevisionRow = { version: string; at: string; author: string; message: string };

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

const VERBS: Record<string, string> = {
  save: "Saved",
  edit: "Edited",
  update: "Updated",
  create: "Created",
  add: "Added",
};
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A revision's label as a person reads it: its first line, without the file's own path or an id
 * (which every row would repeat), and a bare verb ("Save") as what happened ("Saved"). The author and
 * the time are their own columns. */
export function revisionLabel(message: string, path?: string): string {
  let m = message.split("\n")[0]!;
  if (path) m = m.split(path).join(" ");
  m = m
    .replace(UUID, " ")
    .replace(/[[(]\s*[\])]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return VERBS[m.toLowerCase()] ?? (m || "Saved");
}

export function RevisionPicker({
  revisions,
  historyPath,
  picked = [],
  label,
}: {
  revisions: RevisionRow[];
  historyPath: string;
  picked?: string[];
  label: string;
}) {
  const captionId = `${label.replace(/\W+/g, "-").toLowerCase()}-caption`;
  const [count, setCount] = useState(picked.length);
  return (
    <form
      method="get"
      action={historyPath}
      className="cap-stack"
      data-gap="4"
      aria-label={label}
      onChange={(event) =>
        setCount(event.currentTarget.querySelectorAll("input[name=v]:checked").length)
      }
    >
      <div className="cap-table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="cap-table">
          <caption id={captionId} className="cap-sr-only">
            {label}, newest first
          </caption>
          <thead>
            <tr>
              <th scope="col">Compare</th>
              <th scope="col">What changed</th>
              <th scope="col">By</th>
              <th scope="col">Saved</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r, i) => (
              <tr key={r.version} data-state={picked.includes(r.version) ? "selected" : undefined}>
                <td>
                  <label className="cap-check">
                    <input
                      type="checkbox"
                      name="v"
                      value={r.version}
                      defaultChecked={picked.includes(r.version)}
                    />
                    <span className="cap-sr-only">
                      Compare the revision from {utc(r.at)} by {r.author}
                    </span>
                  </label>
                </td>
                <th scope="row">
                  <Link
                    className="cap-table-open"
                    to={`${historyPath}?version=${encodeURIComponent(r.version)}`}
                  >
                    {revisionLabel(r.message)}
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
      <div
        className="cap-cluster app-compare-bar"
        data-gap="3"
        data-ready={count === 2 ? "" : undefined}
      >
        <Button type="submit" variant="primary">
          Compare the two picked
        </Button>
        <span className="cap-muted" aria-live="polite">
          {count === 2
            ? "Two picked. The older is shown first."
            : count > 2
              ? `${count} picked. Compare takes two.`
              : "Pick two revisions. The older is shown first."}
        </span>
      </div>
    </form>
  );
}
