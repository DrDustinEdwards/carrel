// The comparisons that need the person's own working draft: against the site's text, and against
// each AI draft saved beside it. Links to the history page, which does the comparing.

import { Link } from "react-router";
import { Time } from "capsomer/react/time";

export type AiDraftLink = { id: number; client: string; createdAt: string };

export function DraftLinks({ historyPath, againstSite, aiDrafts }: { historyPath: string; againstSite: boolean; aiDrafts: AiDraftLink[] }) {
  if (!againstSite && aiDrafts.length === 0) return null;
  return (
    <ul className="app-flags" aria-label="Compare your draft">
      {againstSite ? (
        <li>
          <span>
            <Link to={`${historyPath}?compare=site`}>Your working draft against the site's version</Link>
          </span>
        </li>
      ) : null}
      {aiDrafts.map((d) => (
        <li key={d.id}>
          <span>
            <Link to={`${historyPath}?compare=ai&ai=${d.id}`}>Your draft against the AI draft from {d.client}</Link>{" "}
            <span className="cap-muted">
              <Time at={d.createdAt} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
