// A `:::chart` block for the insert dialog (E2), and the blocks already in a post's text for the chart
// check (E4). Pure, shared by the browser and the tests. The syntax is Prelum's (README, "Charts in
// posts"): the attributes on the directive, the data as a fenced CSV block, an optional caption.

import { chartBlock, chartBlocks, csvColumns } from "@drdustinedwards/site-helpers/source";

export const CHART_KINDS = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "dot", label: "Dot" },
] as const;

export type ChartKind = (typeof CHART_KINDS)[number]["value"];

export { chartBlock, chartBlocks, csvColumns };
