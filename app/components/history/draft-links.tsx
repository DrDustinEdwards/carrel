// The comparisons that need the person's own working draft: against the site's text, and against
// each AI draft saved beside it. Links to the history page, which does the comparing.

import { routerRenderLink } from "capsomer/react/link";
import { Row, RowList } from "capsomer/react/row-list";
import { Time } from "capsomer/react/time";

export type AiDraftLink = { id: number; client: string; createdAt: string };

export function DraftLinks({
  historyPath,
  againstSite,
  aiDrafts,
}: {
  historyPath: string;
  againstSite: boolean;
  aiDrafts: AiDraftLink[];
}) {
  if (!againstSite && aiDrafts.length === 0) return null;
  return (
    <RowList label="Compare your draft" gap="xs">
      {againstSite ? (
        <Row
          size="sm"
          title="Your working draft against the site's version"
          href={`${historyPath}?compare=site`}
          renderLink={routerRenderLink}
        />
      ) : null}
      {aiDrafts.map((d) => (
        <Row
          key={d.id}
          size="sm"
          title={`Your draft against the AI draft from ${d.client}`}
          href={`${historyPath}?compare=ai&ai=${d.id}`}
          renderLink={routerRenderLink}
          meta={<Time at={d.createdAt} />}
        />
      ))}
    </RowList>
  );
}
