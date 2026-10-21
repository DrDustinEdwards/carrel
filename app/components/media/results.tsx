// The result panels of the media library (routes/media.tsx): one line per file after a bulk action,
// and what emptying the trash deleted and kept.

import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import type { Ref } from "react";

import type { MediaUse } from "./format";

export type FileOutcome = { id: string; ok: boolean; message: string; usedBy?: MediaUse[] };

export function BulkResultPanel({ bulkResult, resultRef, onClear }: { bulkResult: { what: string; outcomes: FileOutcome[] }; resultRef: Ref<HTMLElement>; onClear: () => void }) {
  return (
      <Panel
        title="Result"
        id="media-result"
        ref={resultRef}
        src={`${bulkResult.what}: ${bulkResult.outcomes.filter((o) => o.ok).length} of ${bulkResult.outcomes.length} done`}
        actions={
          <Button size="sm" onClick={() => onClear()}>
            Clear this result
          </Button>
        }
      >
        <ul className="app-flags" aria-label="Result for each file">
          {bulkResult.outcomes.map((o) => (
            <li key={o.id}>
              {o.ok ? <Status tone="ok">Done</Status> : <Status tone="crit">Left as it was</Status>}
              <span>
                <strong className="cap-mono">{o.id}</strong>
                <br />
                {o.message}
                {o.usedBy && o.usedBy.length > 0 ? (
                  <ul className="app-list">
                    {o.usedBy.map((use) => (
                      <li key={`${use.id}:${use.detail}`}>
                        Used by {use.title || use.id} ({use.detail})
                      </li>
                    ))}
                  </ul>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
  );
}

export function TrashEmptiedPanel({ emptied }: { emptied: { deleted: string[]; refused: { id: string; message: string; usedBy: MediaUse[] }[]; more: boolean; unrecorded: number } }) {
  return (
      <Panel title="Trash emptied" src={`${emptied.deleted.length} deleted, ${emptied.refused.length} kept`}>
        <p>
          {emptied.deleted.length === 0 ? "No file was deleted." : `Deleted ${emptied.deleted.length} ${emptied.deleted.length === 1 ? "file" : "files"} from the site.`}
          {emptied.more ? " More files remain in the trash; empty it again to continue." : ""}
          {emptied.unrecorded > 0 ? ` The site deleted them, but Carrel could not save the authorship record for ${emptied.unrecorded}.` : ""}
        </p>
        {emptied.refused.length > 0 ? (
          <Alert tone="warn" title="Kept in the trash">
            <ul className="app-list">
              {emptied.refused.map((r) => (
                <li key={r.id}>
                  <span className="cap-mono">{r.id}</span>: {r.message}
                  {r.usedBy.length > 0 ? ` Used by ${r.usedBy.map((u) => `${u.title || u.id} (${u.detail})`).join(", ")}.` : ""}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </Panel>
  );
}
