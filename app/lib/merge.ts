// The merge view's plan: when the site's copy changed under unsaved text in the room, the two texts
// are set side by side, block by block, so nothing is lost and the person takes the site's changes
// where they want them. A block is one top-level key of the frontmatter, or one run of the body
// between blank lines. With the version both started from (the base), a block only one side changed
// starts on that side; a block both changed starts on the person's own text. Without a base, every
// difference starts on theirs. Shared by the server and the browser; the diff that builds the plan is
// merge.server.ts, so the editor's bundle carries no diff library.

import type { WordPart } from "capsomer/behavior/draft-compare";

/** One block. `gap` is the blank lines written after it in its source, kept so an untouched text comes back byte for byte. */
export type Block = { front: boolean; text: string; gap: string };

export type Pick = "mine" | "theirs" | "both";

export type Segment =
  | { kind: "same"; blocks: Block[] }
  | {
      kind: "choice";
      mine: Block[];
      theirs: Block[];
      /** Which side changed it from the base; null when both did, or Carrel could not read the base. */
      changedBy: "mine" | "theirs" | null;
      /** The pick it opens on. */
      start: Pick;
      /** For one block against one block: their words, from the person's to the site's. */
      words?: WordPart[];
    };

export type MergePlan = {
  segments: Segment[];
  /** Whether the version both started from was read. */
  hasBase: boolean;
  /** The frontmatter fences to write: the person's, else the site's. */
  open: string;
  close: string;
};

export type MergeChoice = Extract<Segment, { kind: "choice" }>;

export const choicesOf = (plan: MergePlan): MergeChoice[] =>
  plan.segments.filter((s): s is MergeChoice => s.kind === "choice");

/** The picks a plan opens on, one per choice, in order. */
export const startPicks = (plan: MergePlan): Pick[] => choicesOf(plan).map((c) => c.start);

/** The merged source for these picks, one per choice segment in order. */
export function merged(plan: MergePlan, picks: readonly Pick[]): string {
  const blocks: Block[] = [];
  let i = 0;
  for (const s of plan.segments) {
    if (s.kind === "same") {
      blocks.push(...s.blocks);
      continue;
    }
    const pick = picks[i++] ?? s.start;
    if (pick !== "theirs") blocks.push(...s.mine);
    if (pick !== "mine") blocks.push(...s.theirs);
  }
  const front = blocks.filter((b) => b.front);
  const body = blocks.filter((b) => !b.front);
  const bodyText = body
    .map((b, at) => {
      if (at === body.length - 1) return b.text + (b.gap || "\n");
      // A block that ended its own source is followed by one blank line here.
      return b.text + (/\n[ \t]*\n/.test(b.gap) ? b.gap : "\n\n");
    })
    .join("");
  if (front.length === 0) return bodyText;
  return `${plan.open}${front.map((b) => b.text).join("\n")}${plan.close}${bodyText}`;
}
