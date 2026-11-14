// The editor's flags and the AI drafts kept beside the writer's own (routes/editor.tsx). Checks and
// reviewers flag; they never decide, so a flag only asks to be read, and the Owner may dismiss it.

import { routerRenderLink } from "capsomer/react/link";
import { Row, RowList } from "capsomer/react/row-list";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Pill, Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import type { ReactNode } from "react";

import type { AiDraftSummary, ItemFinding } from "~/lib/ai.server";
import type { TranscriptDraftSummary } from "~/lib/transcripts.server";
import { plural } from "@drdustinedwards/site-helpers/text";
import "capsomer/flag-list.css";

type Props = {
  flags: ItemFinding[];
  aiDrafts: AiDraftSummary[];
  transcriptDrafts: TranscriptDraftSummary[];
  canPublish: boolean;
  onDismiss: (button: HTMLElement, flag: number) => void;
};

/**
 * One flag, open or dismissed; an open one offers Dismiss to whoever may dismiss it. A row of the row list
 * with Capsomer's flag row look (.cap-flag, flag-list.css): the check that raised it as the title, and the
 * message, with the words it quotes, as the detail, which wraps whole instead of clamping.
 */
export function FlagRow({
  flag,
  status,
  meta,
  onDismiss = null,
}: {
  flag: { check: string; message: string; excerpt?: string | null; status?: string };
  /** The status word; by default Open or Dismissed from the flag's own status. */
  status?: ReactNode;
  meta?: ReactNode;
  onDismiss?: ((button: HTMLElement) => void) | null;
}) {
  return (
    <Row
      size="sm"
      className="cap-flag"
      title={flag.check}
      status={
        status ??
        (flag.status === "open" ? (
          <Status tone="warn">Open</Status>
        ) : (
          <Pill variant="secondary">Dismissed</Pill>
        ))
      }
      detail={
        <>
          {flag.message}
          {flag.excerpt ? (
            <>
              {" "}
              <q>{flag.excerpt}</q>
            </>
          ) : null}
        </>
      }
      meta={meta}
      actions={
        flag.status === "open" && onDismiss ? (
          <Button size="sm" onClick={(event) => onDismiss(event.currentTarget)}>
            Dismiss<span className="cap-sr-only"> flag: {flag.message}</span>
          </Button>
        ) : undefined
      }
    />
  );
}

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
              <FlagRow
                key={f.id}
                flag={f}
                onDismiss={canPublish ? (button) => onDismiss(button, f.id) : null}
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
