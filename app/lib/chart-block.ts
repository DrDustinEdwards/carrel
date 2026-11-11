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

export type ChartFields = {
  type: ChartKind;
  x: string;
  /** One or more value columns; more than one draws a series each. */
  y: readonly string[];
  title: string;
  /** The finding: Enarratio shows it under the title and it is the chart's text alternative. */
  alt: string;
  caption: string;
  csv: string;
};

export { chartBlock, chartBlocks, csvColumns };
