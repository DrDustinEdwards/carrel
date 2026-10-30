// The editor's flags and the AI drafts kept beside the writer's own (routes/editor.tsx). Checks and
// reviewers flag; they never decide, so a flag only asks to be read, and the Owner may dismiss it.

import { Link } from "capsomer/react/link";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import type { AiDraftSummary, ItemFinding } from "~/lib/ai.server";

type Props = {
  flags: ItemFinding[];
  aiDrafts: AiDraftSummary[];
  canPublish: boolean;
  onDismiss: (button: HTMLElement, flag: number) => void;
};

export function FlagsPanel({ flags, aiDrafts, canPublish, onDismiss }: Props) {
  const openFlags = flags.filter((f) => f.status === "open").length;
  return (
    <Panel title="Flags and AI drafts" id="flags" count={openFlags} src={`${aiDrafts.length} AI draft${aiDrafts.length === 1 ? "" : "s"} beside yours`}>
      <div className="app-stack" data-tight>
        {flags.length > 0 ? (
          <ul className="app-flags" aria-label="Flags">
            {flags.map((f) => (
              <li key={f.id}>
                {f.status === "open" ? <Status tone="warn">Open</Status> : <Pill variant="secondary">Dismissed</Pill>}
                <span>
                  {f.message}
                  {f.excerpt ? (
                    <>
                      {" "}
                      <q className="cap-muted">{f.excerpt}</q>
                    </>
                  ) : null}
                </span>
                {f.status === "open" && canPublish ? (
                  <Button size="sm" onClick={(event) => onDismiss(event.currentTarget, f.id)}>
                    Dismiss<span className="cap-sr-only"> flag: {f.message}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {aiDrafts.length > 0 ? (
          <ul className="app-flags" aria-label="AI drafts beside yours">
            {aiDrafts.map((d) => (
              <li key={d.id}>
                <span>
                  <Link to={`ai/${d.id}`}>AI draft from {d.client}</Link>{" "}
                  <span className="cap-muted">
                    <Time at={d.createdAt} /> · {d.words} words
                  </span>
                  {d.note ? <span> · {d.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
                    </div>
    </Panel>
  );
}
