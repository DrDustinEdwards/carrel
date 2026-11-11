// The revisions of one item, newest first, as Capsomer's read-only history list: each line opens its
// source, and any two can be picked and compared. The pick boxes are a GET form before the script runs
// (`?compare=<id>&compare=<id>`), and the Compare link is `?from=<older>&to=<newer>`; the history page
// reads either with comparePicks. Read-only: nothing here changes the site.

import { messageSummary } from "capsomer/behavior/history-list";
import { HistoryList } from "capsomer/react/history-list";

export type RevisionRow = { version: string; at: string; author: string; message: string };

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
  return (
    <HistoryList
      readOnly
      label={label}
      user=""
      compareBase={historyPath}
      defaultPicked={picked}
      versionHref={(id) => `${historyPath}?version=${encodeURIComponent(id)}`}
      entries={revisions.map((r) => ({
        id: r.version,
        kind: "edit",
        who: r.author,
        at: r.at,
        summary: messageSummary(r.message),
      }))}
    />
  );
}
