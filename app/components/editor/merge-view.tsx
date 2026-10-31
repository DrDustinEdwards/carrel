// The merge view (B4/B5): the site's copy changed after the room's text was started, and the room holds
// changes nobody has saved. Nothing is discarded. The person's text and the site's sit side by side,
// block by block; where they differ the person takes theirs, the site's, or both, and where only one side
// changed since the version both started from, that side is already chosen. "Use the merged text" puts
// the result in the room for everyone, on the site's new version, so the next save goes through. Until
// then the room keeps their text exactly as it is.

import { useMemo, useState } from "react";
import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";

import { merged, shown, type Pick, type Segment } from "~/lib/merge";

type Props = {
  segments: Segment[];
  /** Whether Carrel read the version both started from: without it every difference is the person's to choose. */
  hasBase: boolean;
  busy: boolean;
  /** What the merge is applied with: the merged source. */
  apply: (source: string) => void;
  readOnly: boolean;
};

const PICKS: { value: Pick; label: string }[] = [
  { value: "mine", label: "Take mine" },
  { value: "theirs", label: "Take the site's" },
  { value: "both", label: "Keep both" },
];

function Blocks({ blocks, empty }: { blocks: string[]; empty: string }) {
  return blocks.length > 0 ? (
    <div className="app-merge-text">
      {blocks.map((b, i) => (
        <pre key={i}>{shown(b)}</pre>
      ))}
    </div>
  ) : (
    <p className="cap-muted app-merge-text">{empty}</p>
  );
}

export function MergeView({ segments, hasBase, busy, apply, readOnly }: Props) {
  const choices = useMemo(() => segments.filter((s): s is Extract<Segment, { kind: "choice" }> => s.kind === "choice"), [segments]);
  const [picks, setPicks] = useState<Pick[]>(() => choices.map((c) => c.start));
  const open = choices.filter((c) => c.changedBy === null).length;
  let n = -1;
  return (
    <Panel
      title="Merge your changes with the site's"
      id="merge"
      src={`${choices.length} ${choices.length === 1 ? "difference" : "differences"}${hasBase ? `, ${open} changed on both sides` : ""}`}
    >
      <div className="app-stack">
        <p>
          The site's copy changed after this text was started. Your unsaved text is kept exactly as it is until you use the merged text. Choose, for each difference, which to keep;
          {hasBase ? " where only one side changed it, that side is already chosen." : " Carrel could not read the version both started from, so each starts on yours."} Then save as usual.
        </p>
        <ol className="app-merge">
          {segments.map((s, i) => {
            if (s.kind === "same") {
              return (
                <li key={i} className="app-merge-same">
                  <span className="cap-muted">
                    {s.blocks.length} {s.blocks.length === 1 ? "block" : "blocks"} the same on both
                  </span>
                </li>
              );
            }
            const at = ++n;
            return (
              <li key={i} className="app-merge-choice" data-pick={picks[at]}>
                <div className="app-merge-sides">
                  <section aria-label={`Difference ${at + 1}: yours`}>
                    <h3 className="app-merge-side">Yours{s.changedBy === "mine" ? " (changed here)" : ""}</h3>
                    <Blocks blocks={s.mine} empty="Not in yours" />
                  </section>
                  <section aria-label={`Difference ${at + 1}: the site's`}>
                    <h3 className="app-merge-side">On the site{s.changedBy === "theirs" ? " (changed there)" : ""}</h3>
                    <Blocks blocks={s.theirs} empty="Not on the site" />
                  </section>
                </div>
                <Segmented
                  legend={`Difference ${at + 1}`}
                  hideLegend
                  size="sm"
                  value={picks[at] ?? s.start}
                  onChange={(value) => setPicks((now) => now.map((p, j) => (j === at ? value : p)))}
                  options={PICKS.map((p) => ({ ...p, disabled: readOnly || (p.value !== "mine" && p.value !== "theirs" && (s.mine.length === 0 || s.theirs.length === 0)) }))}
                />
              </li>
            );
          })}
        </ol>
        {!readOnly ? (
          <div className="app-actions">
            <Button variant="primary" pending={busy} onClick={() => apply(merged(segments, picks))}>
              Use the merged text
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
