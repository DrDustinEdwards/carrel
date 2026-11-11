// The diff behind the merge view (lib/merge.ts): a three-way merge of the room's text (mine) and the
// site's newer copy (theirs) over the version both started from (the base), block by block. A run
// that only one side changed from the base starts on that side; a run both changed, differently,
// starts on mine; a run both changed the same way is not a choice at all. With no base, every
// difference is a choice that starts on mine. Found on the server so the editor's bundle carries no
// diff library.

import { diffArrays } from "diff";
import { diffWords } from "capsomer/behavior/draft-compare";

import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import type { Block, MergePlan, Segment } from "~/lib/merge";

/** The frontmatter's top-level keys, one block each; a line that is indented, a list item, blank or a comment goes with the key above it. */
function frontBlocks(front: string): Block[] {
  const blocks: string[][] = [];
  for (const line of front.split("\n")) {
    const starts = /^[^\s#-]/.test(line);
    if (starts || blocks.length === 0) blocks.push([line]);
    else blocks[blocks.length - 1]!.push(line);
  }
  return blocks.map((lines) => ({ front: true, text: lines.join("\n"), gap: "" }));
}

/** The body's runs between blank lines, each with the blank lines after it. */
function bodyBlocks(body: string): Block[] {
  const parts = body.split(/(\n(?:[ \t]*\n)+|\n$)/);
  const out: Block[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const gap = parts[i + 1] ?? "";
    if (text === "") {
      // Blank lines before the first run, or at the very end, go with the run before.
      if (out.length > 0) out[out.length - 1]!.gap += gap;
      continue;
    }
    out.push({ front: false, text, gap });
  }
  return out;
}

function blocksOf(source: string): Block[] {
  const parts = splitSource(source.replace(/\r\n/g, "\n"));
  return [...(parts.front === null ? [] : frontBlocks(parts.front)), ...bodyBlocks(parts.body)];
}

const same = (a: Block, b: Block) => a.front === b.front && a.text === b.text;
const equal = (a: Block[], b: Block[]) =>
  a.length === b.length && a.every((x, i) => same(x, b[i]!));

/** For each base block, where it sits unchanged in `other`, or -1. */
function matches(base: Block[], other: Block[]): number[] {
  const at = Array.from({ length: base.length }, () => -1);
  let i = 0;
  let j = 0;
  for (const part of diffArrays(base, other, { comparator: same })) {
    const n = part.count ?? part.value.length;
    if (part.added) j += n;
    else if (part.removed) i += n;
    else for (let k = 0; k < n; k++) at[i + k] = j + k;
    if (!part.added && !part.removed) {
      i += n;
      j += n;
    }
  }
  return at;
}

function choice(mine: Block[], theirs: Block[], changedBy: "mine" | "theirs" | null): Segment {
  const words =
    mine.length === 1 && theirs.length === 1
      ? diffWords(mine[0]!.text, theirs[0]!.text)
      : undefined;
  return {
    kind: "choice",
    mine,
    theirs,
    changedBy,
    start: changedBy === "theirs" ? "theirs" : "mine",
    ...(words ? { words } : {}),
  };
}

/** Pushes a segment, joining runs of blocks that are the same on both sides. */
function push(out: Segment[], segment: Segment) {
  const last = out[out.length - 1];
  if (segment.kind === "same" && last?.kind === "same") last.blocks.push(...segment.blocks);
  else out.push(segment);
}

/** Where the two texts differ with no base: each run of differences is a choice. */
function twoWay(mine: Block[], theirs: Block[]): Segment[] {
  const out: Segment[] = [];
  let pending: { mine: Block[]; theirs: Block[] } | null = null;
  const settle = () => {
    if (!pending) return;
    // Paired runs (the same count on both sides) are decided one pair at a time.
    if (pending.mine.length === pending.theirs.length && pending.mine.length > 1)
      pending.mine.forEach((m, i) => push(out, choice([m], [pending!.theirs[i]!], null)));
    else push(out, choice(pending.mine, pending.theirs, null));
    pending = null;
  };
  let at = 0;
  for (const part of diffArrays(mine, theirs, { comparator: same })) {
    const n = part.count ?? part.value.length;
    if (!part.added && !part.removed) {
      settle();
      // The person's own blocks, so their spacing is kept.
      push(out, { kind: "same", blocks: mine.slice(at, at + n) });
      at += n;
      continue;
    }
    pending ??= { mine: [], theirs: [] };
    (part.removed ? pending.mine : pending.theirs).push(...part.value);
    if (part.removed) at += n;
  }
  settle();
  return out;
}

/**
 * One run the two sides do not share with the base. Where only one side moved away from the base the
 * run is that side's; where both did, the two are lined up and each difference is judged by whether
 * its blocks are still the base's.
 */
function settleRun(out: Segment[], mine: Block[], theirs: Block[], base: Block[]) {
  if (equal(mine, theirs)) {
    if (mine.length > 0) push(out, { kind: "same", blocks: mine });
    return;
  }
  if (equal(mine, base)) return push(out, choice(mine, theirs, "theirs"));
  if (equal(theirs, base)) return push(out, choice(mine, theirs, "mine"));
  const inBase = (blocks: Block[]) => blocks.every((x) => base.some((y) => same(x, y)));
  for (const s of twoWay(mine, theirs)) {
    if (s.kind === "same") {
      push(out, s);
      continue;
    }
    const mb = inBase(s.mine);
    const tb = inBase(s.theirs);
    const by =
      mb && !tb
        ? "theirs"
        : tb && !mb
          ? "mine"
          : mb && tb && s.mine.length === 0
            ? "mine"
            : mb && tb && s.theirs.length === 0
              ? "theirs"
              : null;
    push(out, choice(s.mine, s.theirs, by));
  }
}

/** The merge plan for the person's text against the site's, over the base where Carrel could read it. */
export function mergePlan(mine: string, theirs: string, base: string | null): MergePlan {
  const m = blocksOf(mine);
  const t = blocksOf(theirs);
  const mineParts = splitSource(mine.replace(/\r\n/g, "\n"));
  const theirParts = splitSource(theirs.replace(/\r\n/g, "\n"));
  const fences =
    mineParts.front !== null
      ? { open: mineParts.open, close: mineParts.close }
      : theirParts.front !== null
        ? { open: theirParts.open, close: theirParts.close }
        : { open: "---\n", close: "\n---\n\n" };
  if (base === null) return { segments: twoWay(m, t), hasBase: false, ...fences };

  const b = blocksOf(base);
  const inMine = matches(b, m);
  const inTheirs = matches(b, t);
  const out: Segment[] = [];
  let i = 0;
  let mi = 0;
  let ti = 0;
  while (i <= b.length) {
    // The next base block both sides still hold, in order: everything before it is one unsettled run.
    let k = i;
    while (k < b.length && !(inMine[k]! >= mi && inTheirs[k]! >= ti)) k++;
    const mEnd = k < b.length ? inMine[k]! : m.length;
    const tEnd = k < b.length ? inTheirs[k]! : t.length;
    const baseRun = b.slice(i, k);
    const mineRun = m.slice(mi, mEnd);
    const theirRun = t.slice(ti, tEnd);
    settleRun(out, mineRun, theirRun, baseRun);
    if (k === b.length) break;
    push(out, { kind: "same", blocks: [m[mEnd]!] });
    i = k + 1;
    mi = mEnd + 1;
    ti = tEnd + 1;
  }
  return { segments: out, hasBase: true, ...fences };
}
