// The editor's History panel (routes/editor.tsx): the newest revisions on the site, and links to compare
// the drafts kept in Carrel. The history page lists every revision.

import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Panel } from "capsomer/react/panel";

import { DraftLinks, type AiDraftLink } from "./draft-links";
import { RevisionPicker, type RevisionRow } from "./revision-picker";

type Props = {
  revisions: RevisionRow[] | null;
  revisionCount: number;
  historyError: string | null;
  historyPath: string;
  /** "post", "page": what the revisions are of. */
  noun: string;
  /** Whether a draft in Carrel can be compared against the site's copy. */
  againstSite: boolean;
  aiDrafts: AiDraftLink[];
};

export function HistoryPanel({ revisions, revisionCount, historyError, historyPath, noun, againstSite, aiDrafts }: Props) {
  return (
    <Panel
      title="History"
      id="history"
      count={revisionCount}
      src="Saves and publishes on the site"
      actions={
        revisionCount > 0 ? (
          <Link className="cap-btn" data-size="sm" to={historyPath}>
            All revisions
          </Link>
        ) : undefined
      }
    >
      <div className="app-stack" data-tight>
        {historyError ? <Banner tone="warn">{historyError}</Banner> : null}
        {revisions && revisions.length > 0 ? (
          <RevisionPicker revisions={revisions} historyPath={historyPath} label="Recent revisions" />
        ) : revisions ? (
          <p className="cap-muted">The site has no saved revisions of this {noun} yet.</p>
        ) : null}
        <DraftLinks historyPath={historyPath} againstSite={againstSite} aiDrafts={aiDrafts} />
      </div>
    </Panel>
  );
}
