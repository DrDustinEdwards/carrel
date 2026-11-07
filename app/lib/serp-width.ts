// How wide a search result's title and description are, in pixels, in the font Google sets them in
// (Arial, 20px for the title and 14px for the description on desktop). Google cuts by width, not by
// characters, so a title of capitals clips sooner than one of small letters. Browser only: the server
// has no canvas, so it answers null and the editor shows "Measuring" until the page is live. The limits
// and font sizes are Prelum's, the ones the sites' head tags and audit use; this file only measures.

import { SERP_DESCRIPTION, SERP_TITLE } from "@drdustinedwards/site-helpers/head";

export const SERP_WIDTH = {
  title: { limit: SERP_TITLE.px, font: `${SERP_TITLE.font}px arial, sans-serif` },
  description: { limit: SERP_DESCRIPTION.px, font: `${SERP_DESCRIPTION.font}px arial, sans-serif` },
};

let context: CanvasRenderingContext2D | null | undefined;

export function textWidth(text: string, font: string): number | null {
  if (typeof document === "undefined") return null;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = font;
  return Math.round(context.measureText(text).width);
}
