// The merge view: the site's copy changed after the room's text was started, and the room holds
// changes nobody has saved, so a save would be refused. Nothing is discarded. The room's text and the
// site's sit side by side, block by block; for each difference the person keeps theirs, the site's,
// or both, and where only one side changed it since the version both started from, that side is
// already chosen. "Use the merged text" puts the result in the room for everyone, on the site's new
// version, so the next save goes through. Until then the room keeps its text exactly as it is.

import { useState } from "react";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";

import { choicesOf, startPicks, type Block, type MergePlan, type Pick } from "~/lib/merge";

type Props = {
  plan: MergePlan;
  busy: boolean;
  /** Applies the picks, one per difference in order. */
  apply: (picks: Pick[]) => void;
};

const PICKS: { value: Pick; label: string }[] = [
  { value: "mine", label: "Keep Carrel's" },
  { value: "theirs", label: "Take the site's" },
  { value: "both", label: "Keep both" },
];

function Side({
  blocks,
  empty,
  words,
  show,
}: {
  blocks: Block[];
  empty: string;
  words?: { op: "same" | "ins" | "del"; text: string }[];
  show: "del" | "ins";
}) {
  if (blocks.length === 0) return <p className="app-merge-text app-merge-empty">{empty}</p>;
  if (words) {
    // One block against one: the words only this side has are marked, on each side alike.
    return (
      <pre className="app-merge-text">
        {words.map((w, i) => {
          if (w.op === "same") return w.text;
          if (w.op !== show) return null;
          return (
            <mark key={i} className="app-merge-mark">
              <span className="cap-sr-only"> only here: </span>
              {w.text}
            </mark>
          );
        })}
      </pre>
    );
  }
  return (
    <div className="app-merge-text">
      {blocks.map((b, i) => (
        <pre key={i}>{b.text}</pre>
      ))}
    </div>
  );
}

export function MergeView({ plan, busy, apply }: Props) {
  const choices = choicesOf(plan);
  const [picks, setPicks] = useState<Pick[]>(() => startPicks(plan));
  const both = choices.filter((c) => c.changedBy === null).length;
  // Each choice's place among the choices, by its segment's place in the plan.
  const order = plan.segments.map(
    (s, i) => plan.segments.slice(0, i + 1).filter((x) => x.kind === "choice").length - 1,
  );
  return (
    <Panel
      title="Merge Carrel's text with the site's"
      id="merge"
      src={`${choices.length} ${choices.length === 1 ? "difference" : "differences"}${plan.hasBase ? `, ${both} changed on both` : ""}`}
    >
      <div className="cap-stack" data-gap="6">
        <p>
          Choose which text to keep for each difference, then use the merged text and save as usual.
          The unsaved text stays exactly as it is until then.{" "}
          {plan.hasBase
            ? "Where only one side changed a passage, that side is already chosen."
            : "Carrel could not read the version both started from, so each starts on Carrel's."}
        </p>
        <ol className="app-merge">
          {plan.segments.map((s, i) => {
            if (s.kind === "same") {
              return (
                <li key={i} className="app-merge-same cap-muted">
                  {s.blocks.length} {s.blocks.length === 1 ? "passage" : "passages"} the same on
                  both
                </li>
              );
            }
            const n = order[i]!;
            const pick = picks[n] ?? s.start;
            const label = `Difference ${n + 1}`;
            return (
              <li key={i} className="app-merge-choice" data-pick={pick}>
                <div className="app-merge-sides">
                  <section
                    aria-label={`${label}: in Carrel`}
                    data-kept={pick !== "theirs" ? "" : undefined}
                  >
                    <h3 className="app-merge-side">
                      In Carrel{s.changedBy === "mine" ? " (changed here)" : ""}
                      {pick === "theirs" ? ", left out" : ""}
                    </h3>
                    <Side blocks={s.mine} empty="Not in Carrel's text" words={s.words} show="del" />
                  </section>
                  <section
                    aria-label={`${label}: on the site`}
                    data-kept={pick !== "mine" ? "" : undefined}
                  >
                    <h3 className="app-merge-side">
                      On the site{s.changedBy === "theirs" ? " (changed there)" : ""}
                      {pick === "mine" ? ", left out" : ""}
                    </h3>
                    <Side blocks={s.theirs} empty="Not on the site" words={s.words} show="ins" />
                  </section>
                </div>
                <Segmented
                  legend={`${label}: which to keep`}
                  hideLegend
                  size="sm"
                  value={pick}
                  onChange={(value) => setPicks((now) => now.map((p, j) => (j === n ? value : p)))}
                  options={PICKS.map((p) => ({
                    ...p,
                    // Keeping both needs a passage on each side.
                    disabled: p.value === "both" && (s.mine.length === 0 || s.theirs.length === 0),
                  }))}
                />
              </li>
            );
          })}
        </ol>
        <div className="cap-cluster" data-gap="3">
          <Button variant="primary" pending={busy} onClick={() => apply(picks)}>
            Use the merged text
          </Button>
        </div>
      </div>
    </Panel>
  );
}
