// What the site posts' history page and a book file's history page share: what a view is, the
// two-text comparison, the line or word switch, and the panels that show one version or a comparison.

import type { ReactNode } from "react";
import { useParamChoice } from "capsomer/react/route-hooks";
import { Link } from "capsomer/react/link";
import { DraftCompare, DraftPatch } from "capsomer/react/draft-compare";
import { unifiedPatch } from "capsomer/behavior/draft-compare";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Pill } from "capsomer/react/status";
import { Time } from "capsomer/react/time";

export type Side = { title: string; who?: string; time?: string; text: string };
type By = "line" | "word";
export type View =
  | { kind: "none" }
  | { kind: "problem"; message: string }
  | {
      kind: "source";
      version: string;
      message: string;
      author: string;
      at: string;
      source: string;
      current: boolean;
      previous: string | null;
      newest: string | null;
    }
  | {
      kind: "compare";
      heading: string;
      lead: string;
      patch: string | null;
      before: Side | null;
      after: Side | null;
    };

/** Both texts are in Carrel: line by line is a patch built here, word by word the two texts side by side. */
export function sides(
  heading: string,
  lead: string,
  fileName: string,
  before: Side,
  after: Side,
  by: By,
): View {
  if (by === "word") return { kind: "compare", heading, lead, patch: null, before, after };
  const patch = unifiedPatch(
    fileName,
    { text: before.text, label: before.title },
    { text: after.text, label: after.title },
  );
  return { kind: "compare", heading, lead, patch, before: null, after: null };
}

export function SourcePanel({
  view,
  historyPath,
  noun,
  restore,
}: {
  view: Extract<View, { kind: "source" }>;
  historyPath: string;
  noun: "revision" | "version";
  restore?: ReactNode;
}) {
  return (
    <Panel
      title={view.message || (noun === "revision" ? "Revision" : "Version")}
      src={
        <>
          by {view.author}, <Time at={view.at} format="exact" />
        </>
      }
      actions={
        <>
          {view.current ? <Pill tone="ok">Current</Pill> : null}
          {view.previous ? (
            <Link
              className="cap-btn"
              to={`${historyPath}?from=${encodeURIComponent(view.previous)}&to=${encodeURIComponent(view.version)}`}
            >
              Changes in this {noun}
            </Link>
          ) : null}
          {view.newest ? (
            <Link
              className="cap-btn"
              to={`${historyPath}?from=${encodeURIComponent(view.version)}&to=${encodeURIComponent(view.newest)}`}
            >
              Compare with the current version
            </Link>
          ) : null}
          {restore}
        </>
      }
    >
      <pre
        className="app-ai-draft"
        aria-label={noun === "revision" ? "Source of this revision" : "Text of this version"}
      >
        {view.source}
      </pre>
    </Panel>
  );
}

/** `options` lists the two views in the page's order, the default first. */
export function ComparePanel({
  view,
  by,
  options,
  id,
}: {
  view: Extract<View, { kind: "compare" }>;
  by: By;
  options: [{ value: By; label: string }, { value: By; label: string }];
  id: string;
}) {
  const [shown, setBy] = useParamChoice("by", by, [options[0].value, options[1].value]);
  return (
    <Panel
      title={view.heading}
      description={view.lead}
      actions={
        <Segmented
          legend="Compare by"
          hideLegend
          size="sm"
          value={shown}
          onChange={setBy}
          options={options}
        />
      }
    >
      {view.patch !== null ? (
        <DraftPatch patch={view.patch} title={view.heading} id={`${id}-patch`} />
      ) : view.before && view.after ? (
        <DraftCompare before={view.before} after={view.after} id={`${id}-compare`} />
      ) : null}
    </Panel>
  );
}
