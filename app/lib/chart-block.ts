// A `:::chart` block for the insert dialog (E2), and the blocks already in a post's text for the chart
// check (E4). Pure, shared by the browser and the tests. The syntax is Prelum's (README, "Charts in
// posts"): the attributes on the directive, the data as a fenced CSV block, an optional caption.

import { parseCsv } from "capsomer/behavior/csv";
import { escapeHtml } from "@dustinedwards/site-runtime/html";

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

/** The CSV's column names, and which hold only numbers (the columns a chart can measure). */
export function csvColumns(csv: string): { name: string; numeric: boolean }[] {
  // Capsomer's reader (RFC 4180, a byte order mark dropped); a blank line is no row, and cells are trimmed.
  const [names, ...table] = parseCsv(csv)
    .filter((r) => r.length > 1 || r[0]!.trim() !== "")
    .map((r) => r.map((c) => c.trim()));
  if (!names) return [];
  return names.map((name, i) => ({
    name,
    numeric:
      table.length > 0 &&
      table.every((r) => r[i] !== undefined && r[i] !== "" && Number.isFinite(Number(r[i]))),
  }));
}

// A directive attribute is double-quoted on one line; a quote or an ampersand in it is written as a
// character reference, which the directive parser reads back.
const attr = (value: string) => escapeHtml(value.replace(/\s+/g, " ").trim());

/** The block the dialog inserts, in Prelum's syntax. Empty fields are left out. */
export function chartBlock(f: ChartFields): string {
  const attrs = [`type="${f.type}"`, `x="${attr(f.x)}"`, `y="${attr(f.y.join(","))}"`];
  if (f.title.trim()) attrs.push(`title="${attr(f.title)}"`);
  attrs.push(`alt="${attr(f.alt)}"`);
  // A fence inside the data would end the block early; CSV never needs one.
  const csv = f.csv
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^```.*$/gm, "")
    .trim();
  return [
    `:::chart{${attrs.join(" ")}}`,
    "```csv",
    csv,
    "```",
    ...(f.caption.trim() ? [f.caption.trim()] : []),
    ":::",
  ].join("\n");
}

/** A fence closes on a run of its own character at least as long, and nothing after it. */
function closes(line: string, fence: string): boolean {
  const run = /^(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return Boolean(run && run[0] === fence[0] && run.length >= fence.length);
}

/** Each `:::chart` block in a post's body, with the line it starts on. A fence inside one does not end it. */
export function chartBlocks(body: string): { line: number; text: string }[] {
  const lines = body.split("\n");
  const found: { line: number; text: string }[] = [];
  // A fence outside a chart (a code sample showing the syntax) holds no chart.
  let outer: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (outer) {
      if (closes(line, outer)) outer = null;
      continue;
    }
    const opened = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (opened) {
      outer = opened;
      continue;
    }
    if (!/^:::chart\b/.test(line)) continue;
    let fence: string | null = null;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const inner = lines[j] ?? "";
      const open = /^(`{3,}|~{3,})/.exec(inner);
      if (fence) {
        if (closes(inner, fence)) fence = null;
      } else if (open) fence = open[1] ?? null;
      else if (/^:::\s*$/.test(inner)) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    found.push({ line: i + 1, text: lines.slice(i, end + 1).join("\n") });
    i = end;
  }
  return found;
}
