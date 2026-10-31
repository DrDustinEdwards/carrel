// How wide a search result's title and description are, in pixels, in the font Google sets them in
// (Arial, 20px for the title and 14px for the description on desktop). Google cuts by width, not by
// characters, so a title of capitals clips sooner than one of small letters. Browser only: the server
// has no canvas, so it answers null and the editor shows "Measuring" until the page is live.

export const SERP_WIDTH = {
  title: { limit: 580, font: "20px arial, sans-serif" },
  description: { limit: 920, font: "14px arial, sans-serif" },
} as const;

let context: CanvasRenderingContext2D | null | undefined;

export function textWidth(text: string, font: string): number | null {
  if (typeof document === "undefined") return null;
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = font;
  return Math.round(context.measureText(text).width);
}
