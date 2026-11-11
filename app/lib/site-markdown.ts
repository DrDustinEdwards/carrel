// Each site's own Markdown for the things Carrel's editor inserts, shared by the server and the
// browser (the editor runs in both). One place per site, so the editor writes what the site renders.

import { figureMarkup as prelumFigureMarkup } from "@drdustinedwards/site-helpers/source";
import type { Scaffold } from "capsomer/react/markdown-editor";

/** The sites whose renderer reads Prelum's `:::figure` directive (its caption is the directive's body); the others get plain
 *  Markdown with the caption as an emphasized line. germomics renders its Markdown with Prelum too, since germomics#186. */
const FIGURE_SITES = new Set(["dustinedwards", "germomics"]);

/** How the site places an image with its alt text and, when it has one, its caption (stage 3), in the site's own dialect.
 *  An empty alt is a decorative pick, always plain `![""](url)`. */
export function figureMarkup(site: string, url: string, alt: string, caption = ""): string {
  return prelumFigureMarkup(url, alt, { caption, figure: FIGURE_SITES.has(site) });
}

/**
 * The blocks the toolbar and the `/` menu insert, in the site's own dialect. Alt is mandatory on
 * :::chart and :::diagram and the site's build fails without it, so the cursor lands inside alt="".
 * Capsomer's editor knows no block syntax; these are the data it is given.
 */
export const SCAFFOLDS: Scaffold[] = [
  {
    id: "chart",
    label: "Chart",
    hint: "Bar, line, dot or area from inline CSV",
    icon: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    text: [
      ':::chart{type=bar x=name y=value title="" alt=""}',
      "```csv",
      "name,value",
      "first,1",
      "```",
      "An optional caption.",
      ":::",
    ].join("\n"),
    cursorAfter: 'alt="',
  },
  {
    id: "diagram",
    label: "Diagram",
    hint: "Mermaid, rendered by build:diagrams",
    icon: "M4 4h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 15h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM10 6.5h4a3 3 0 0 1 3 3V15",
    text: [
      ':::diagram{title="" alt=""}',
      "```mermaid",
      "flowchart LR",
      "  A[Start] --> B[End]",
      "```",
      "An optional caption.",
      ":::",
    ].join("\n"),
    cursorAfter: 'alt="',
  },
  {
    id: "figure",
    label: "Figure",
    hint: "An image with a caption",
    icon: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 14l4-4 5 5M6 21h12",
    text: [':::figure{src="" alt=""}', "A caption.", ":::"].join("\n"),
    cursorAfter: 'src="',
  },
];
