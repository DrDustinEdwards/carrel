// The editor's flags and the AI drafts kept beside the writer's own (routes/editor.tsx). Checks and
// reviewers flag; they never decide, so a flag only asks to be read, and the Owner may dismiss it.

import { routerRenderLink } from "capsomer/react/link";
import { Row, RowList } from "capsomer/react/row-list";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

import type { AiDraftSummary, ItemFinding } from "~/lib/ai.server";
import type { TranscriptDraftSummary } from "~/lib/transcripts.server";
import { plural } from "@drdustinedwards/site-helpers/text";

type Props = {
  flags: ItemFinding[];
  aiDrafts: AiDraftSummary[];
  transcriptDrafts: TranscriptDraftSummary[];
  canPublish: boolean;
  onDismiss: (button: HTMLElement, flag: number) => void;
};

export function FlagsPanel({ flags, aiDrafts, transcriptDrafts, canPublish, onDismiss }: Props) {
  const openFlags = flags.filter((f) => f.status === "open").length;
  const drafts = aiDrafts.length + transcriptDrafts.length;
  return (
    <Panel
      title="Flags and AI drafts"
      id="flags"
      count={openFlags}
      src={`${plural(drafts, "draft")} beside yours`}
    >
      <div className="cap-stack" data-gap="4">
        {flags.length > 0 ? (
          <RowList label="Flags" gap="xs">
            {flags.map((f) => (
              <Row
                key={f.id}
                size="sm"
                title={f.message}
                status={
                  f.status === "open" ? (
                    <Status tone="warn">Open</Status>
                  ) : (
                    <Pill variant="secondary">Dismissed</Pill>
                  )
                }
                detail={f.excerpt ? <q>{f.excerpt}</q> : undefined}
                actions={
                  f.status === "open" && canPublish ? (
                    <Button size="sm" onClick={(event) => onDismiss(event.currentTarget, f.id)}>
                      Dismiss<span className="cap-sr-only"> flag: {f.message}</span>
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </RowList>
        ) : null}
        {aiDrafts.length > 0 ? (
          <RowList label="AI drafts beside yours" gap="xs">
            {aiDrafts.map((d) => (
              <Row
                key={d.id}
                size="sm"
                title={`AI draft from ${d.client}`}
                href={`ai/${d.id}`}
                renderLink={routerRenderLink}
                detail={d.note || undefined}
                meta={
                  <>
                    <Time at={d.createdAt} /> · {d.words} words
                  </>
                }
              />
            ))}
          </RowList>
        ) : null}
        {transcriptDrafts.length > 0 ? (
          <RowList label="Transcript drafts" gap="xs">
            {transcriptDrafts.map((d) => (
              <Row
                key={d.id}
                size="sm"
                title={`Transcript draft from ${d.client}`}
                href={`transcript/${d.id}`}
                renderLink={routerRenderLink}
                detail={d.note || undefined}
                meta={<Time at={d.createdAt} />}
              />
            ))}
          </RowList>
        ) : null}
      </div>
    </Panel>
  );
}
