// What the site posts' history page and a book file's history page share: what a view is, the
// two-text comparison, the line or word switch, and the panels that show one version or a comparison.

import type { ReactNode } from "react";
import { Link, useLocation, useNavigate, useNavigation } from "react-router";
import { DraftCompare, DraftPatch } from "capsomer/react/draft-compare";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Pill } from "capsomer/react/status";
import { ExactTime } from "~/components/exact-time";

import { unifiedPatch } from "~/lib/patch";

export type Side = { title: string; who?: string; time?: string; text: string };
type By = "line" | "word";
export type View =
  | { kind: "none" }
  | { kind: "problem"; message: string }
  | { kind: "source"; version: string; message: string; author: string; at: string; source: string; current: boolean; previous: string | null; newest: string | null }
  | { kind: "compare"; heading: string; lead: string; patch: string | null; before: Side | null; after: Side | null };

export const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Both texts are in Carrel: line by line is a patch built here, word by word the two texts side by side. */
export function sides(heading: string, lead: string, fileName: string, before: Side, after: Side, by: By): View {
  if (by === "word") return { kind: "compare", heading, lead, patch: null, before, after };
  const patch = unifiedPatch(fileName, { text: before.text, label: before.title }, { text: after.text, label: after.title });
  return { kind: "compare", heading, lead, patch, before: null, after: null };
}

/** The switch moves at once, while the other view loads; the loader's answer confirms it. */
function useCompareBy(by: By, first: By, other: By): [By, (next: By) => void] {
  const navigate = useNavigate();
  const location = useLocation();
  const pending = useNavigation().location;
  const shown = pending ? (new URLSearchParams(pending.search).get("by") === other ? other : first) : by;
  const setBy = (next: By) => {
    const params = new URLSearchParams(location.search);
    params.set("by", next);
    void navigate(`${location.pathname}?${params.toString()}`, { preventScrollReset: true });
  };
  return [shown, setBy];
}

export function SourcePanel({ view, historyPath, noun, restore }: { view: Extract<View, { kind: "source" }>; historyPath: string; noun: "revision" | "version"; restore?: ReactNode }) {
  return (
    <Panel
      title={view.message || (noun === "revision" ? "Revision" : "Version")}
      src={
        <>
          by {view.author}, <ExactTime at={view.at} />
        </>
      }
      actions={
        <>
          {view.current ? <Pill tone="ok">Current</Pill> : null}
          {view.previous ? (
            <Link className="cap-btn" to={`${historyPath}?v=${encodeURIComponent(view.previous)}&v=${encodeURIComponent(view.version)}`}>
              Changes in this {noun}
            </Link>
          ) : null}
          {view.newest ? (
            <Link className="cap-btn" to={`${historyPath}?v=${encodeURIComponent(view.version)}&v=${encodeURIComponent(view.newest)}`}>
              Compare with the current version
            </Link>
          ) : null}
          {restore}
        </>
      }
    >
      <pre className="app-ai-draft" aria-label={noun === "revision" ? "Source of this revision" : "Text of this version"}>
        {view.source}
      </pre>
    </Panel>
  );
}

/** `options` lists the two views in the page's order, the default first. */
export function ComparePanel({ view, by, options, id }: { view: Extract<View, { kind: "compare" }>; by: By; options: [{ value: By; label: string }, { value: By; label: string }]; id: string }) {
  const [shown, setBy] = useCompareBy(by, options[0].value, options[1].value);
  return (
    <Panel title={view.heading} description={view.lead} actions={<Segmented legend="Compare by" hideLegend size="sm" value={shown} onChange={setBy} options={options} />}>
      {view.patch !== null ? <DraftPatch patch={view.patch} title={view.heading} id={`${id}-patch`} /> : view.before && view.after ? <DraftCompare before={view.before} after={view.after} id={`${id}-compare`} /> : null}
    </Panel>
  );
}
