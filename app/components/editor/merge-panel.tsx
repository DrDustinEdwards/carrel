// The merge of Carrel's text with the site's newer copy. A page loads it only when the two have diverged, which is
// rare, so the editor's first load does not carry the merge view.

import { DraftMerge, mergeCountsText } from "capsomer/react/draft-compare";
import { Panel } from "capsomer/react/panel";
import type { ComponentProps } from "react";

/** The merge view's words: the room's text is Carrel's, the newer copy is the site's. */
const MERGE_LABELS = {
  mine: "In Carrel",
  theirs: "On the site",
  keepMine: "Keep Carrel's",
  keepTheirs: "Take the site's",
  notInMine: "Not in Carrel's text",
  notInTheirs: "Not on the site",
  withoutBase: "Carrel could not read the version both started from, so each starts on Carrel's.",
};

type Plan = ComponentProps<typeof DraftMerge>["plan"];

export default function MergePanel({
  plan,
  pending,
  onApply,
}: {
  plan: Plan;
  pending: boolean;
  onApply: ComponentProps<typeof DraftMerge>["onApply"];
}) {
  return (
    <Panel title="Merge Carrel's text with the site's" id="merge" src={mergeCountsText(plan)}>
      <DraftMerge plan={plan} pending={pending} labels={MERGE_LABELS} onApply={onApply} />
    </Panel>
  );
}
