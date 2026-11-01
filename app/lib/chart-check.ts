// The chart check (E4) and the suggested finding (E5), on Prelum's own chart code: each `:::chart` block
// is run through Prelum's editorial pack with `strictCharts` (Prelum v0.27.0), the option that refuses a
// chart with no title, author text above reading grade 9 or too many series, so the editor names the
// same problems the site's render would only warn about. The check flags; Dustin decides (CLAUDE.md):
// the editor shows each as an advisory line in the publish checks, never a block.
//
// Heavy (Prelum's pack draws with Enarratio and Observable Plot), so the editor imports it only when the
// text holds a chart. Nothing here reaches the site or the network.

import { editorialPack } from "@drdustinedwards/site-helpers/render/packs";
import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";

import { chartBlocks } from "~/lib/chart-block";

export type ChartFinding = {
  /** The line the block starts on, in the text given. */
  line: number;
  message: string;
  /** Prelum refuses it under strictCharts (no title, too many series, above grade 9, or a block it cannot draw). */
  strict: boolean;
};

type Run = { refused: string | null; warnings: string[]; summary: string | null };

/** One block through Prelum's pack: its refusal under `strict`, its warnings, and Enarratio's summary of the data. */
function run(block: string, strict: boolean): Run {
  const tree = fromMarkdown(block, { extensions: [directive()], mdastExtensions: [directiveFromMarkdown()] });
  const warnings: string[] = [];
  const setup = editorialPack({ assetPrefix: "carrel-", strictCharts: strict }).setup({ file: "chart", body: block, warn: (w) => warnings.push(w.message) });
  try {
    for (const [plugin, ...args] of setup.remark as [(...a: unknown[]) => (tree: unknown) => void, ...unknown[]][]) plugin(...args)(tree);
    setup.result?.();
  } catch (error) {
    // Prelum's ContentError names the file and the block first; the editor names the line instead.
    return { refused: unprefixed((error instanceof Error ? error.message : String(error)).replace(/^chart: /, "")), warnings, summary: null };
  }
  // The pack's rehype half takes the models the remark half built: the first is the charts'.
  const models = (setup.rehype[0]?.[1] ?? []) as { html?: string }[];
  const html = models[0]?.html ?? "";
  const summary = /<p class="enarratio-summary">([^<]*)<\/p>/.exec(html)?.[1] ?? null;
  return { refused: null, warnings, summary: summary ? decode(summary) : null };
}

/** A message without the `:::chart "type": ` Prelum puts before it. */
const unprefixed = (message: string) => message.replace(/^:::chart "[^"]*": /, "");

const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _);

/** Every chart's problems in a post's body: what strictCharts refuses, then what Prelum only warns about. */
export function checkCharts(body: string): ChartFinding[] {
  const out: ChartFinding[] = [];
  for (const { line, text } of chartBlocks(body)) {
    const strict = run(text, true);
    if (strict.refused) out.push({ line, message: strict.refused, strict: true });
    // A refused block stops before its warnings; the lenient run lists the ones the refusal did not name.
    const warnings = strict.refused ? run(text, false).warnings : strict.warnings;
    for (const warning of warnings) {
      const message = unprefixed(warning);
      if (!strict.refused?.includes(message)) out.push({ line, message, strict: false });
    }
  }
  return out;
}

/**
 * A finding drafted from the chart's data (E5): the first sentence of Enarratio's own summary of it, for
 * Dustin to take, change or ignore. Null when the block cannot be drawn. It is a suggestion only; the
 * dialog never puts it in the post unasked.
 */
export function suggestFinding(block: string): string | null {
  const { summary } = run(block, false);
  if (!summary) return null;
  return /^.*?[.!?](?=\s|$)/.exec(summary)?.[0] ?? summary;
}
