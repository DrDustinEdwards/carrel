// The merge view's blocks (B4/B5): when the site's copy changed under unsaved text in Carrel, the two are
// set side by side, block by block, so the person keeps their text and takes the site's changes where
// they want them. A block is the frontmatter, or a run of the body between blank lines. With the version
// both started from (the base), a block only one side changed is taken from that side; a block both
// changed is the person's to choose. Without a base, every difference is. Nothing is dropped by default:
// a choice starts on the person's own text. Shared by the server and the browser; the diff that finds
// the segments is merge.server.ts, so it stays out of the editor's bundle.

import { splitSource } from "@dustinedwards/site-api/frontmatter";

export type Pick = "mine" | "theirs" | "both";

export type Segment =
  | { kind: "same"; blocks: string[] }
  /** `start`: the choice it opens on. `changedBy`: which side changed it from the base, null when both did or there is no base. */
  | { kind: "choice"; mine: string[]; theirs: string[]; start: Pick; changedBy: "mine" | "theirs" | null };

const FRONT = "\u0000front\u0000";

/** A source as blocks: its frontmatter whole (marked, so it never lines up with a body block), then the body's paragraphs. */
export function blocksOf(source: string): string[] {
  const parts = splitSource(source);
  const body = parts.body
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/^\n+|\s+$/g, ""))
    .filter((b) => b !== "");
  return parts.front === null ? body : [`${FRONT}${parts.open}${parts.front}${parts.close}`, ...body];
}

/** Back to a source: the frontmatter as it was written, then the body's blocks a blank line apart. */
function sourceOf(blocks: string[]): string {
  const front = blocks[0]?.startsWith(FRONT) ? blocks[0].slice(FRONT.length) : null;
  const body = (front === null ? blocks : blocks.slice(1)).join("\n\n");
  if (front === null) return body === "" ? "" : `${body}\n`;
  return `${front.replace(/\s*$/, "\n")}${body === "" ? "" : `\n${body}\n`}`;
}

/** A block as a person reads it: the frontmatter without its marker. */
export const shown = (block: string) => (block.startsWith(FRONT) ? block.slice(FRONT.length).trim() : block);

/** The merged source for these choices, one per choice segment in order. */
export function merged(segments: Segment[], picks: Pick[]): string {
  const blocks: string[] = [];
  let i = 0;
  for (const s of segments) {
    if (s.kind === "same") {
      blocks.push(...s.blocks);
      continue;
    }
    const pick = picks[i++] ?? s.start;
    if (pick !== "theirs") blocks.push(...s.mine);
    if (pick !== "mine") blocks.push(...s.theirs);
  }
  // Two frontmatters kept by "both" cannot both lead the file: the first is it, the other goes in the body as text.
  return sourceOf(blocks.map((b, at) => (at > 0 && b.startsWith(FRONT) ? shown(b) : b)));
}

