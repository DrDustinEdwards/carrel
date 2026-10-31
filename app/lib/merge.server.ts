// The diff behind the merge view (lib/merge.ts): the segments of the person's text against the site's,
// found on the server so the editor's bundle carries no diff library.

import { diffArrays } from "diff";

import { blocksOf, type Segment } from "~/lib/merge";

function holds(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((b, j) => haystack[i + j] === b)) return true;
  return false;
}

/** The person's text against the site's, with the base where Carrel can read it. */
export function mergeSegments(mine: string, theirs: string, base: string | null): Segment[] {
  const baseBlocks = base === null ? null : blocksOf(base);
  const out: Segment[] = [];
  let pending: { mine: string[]; theirs: string[] } | null = null;
  const settle = () => {
    if (!pending) return;
    const { mine: m, theirs: t } = pending;
    pending = null;
    // Side by side changes the diff ran together (the frontmatter and the first paragraph, both edited)
    // are decided one pair at a time when they pair up.
    if (m.length === t.length && m.length > 1) {
      for (let i = 0; i < m.length; i++) choose([m[i]!], [t[i]!]);
      return;
    }
    choose(m, t);
  };
  const choose = (m: string[], t: string[]) => {
    // Only the site moved away from the base here: its blocks are taken. Only the person did: the person's are kept.
    let changedBy: "mine" | "theirs" | null = null;
    if (baseBlocks) {
      const mineIsBase = holds(baseBlocks, m) && m.length > 0;
      const theirsIsBase = holds(baseBlocks, t) && t.length > 0;
      if (mineIsBase && !theirsIsBase) changedBy = "theirs";
      else if (theirsIsBase && !mineIsBase) changedBy = "mine";
      else if (m.length === 0 && !holds(baseBlocks, t)) changedBy = "theirs";
      else if (t.length === 0 && !holds(baseBlocks, m)) changedBy = "mine";
    }
    out.push({ kind: "choice", mine: m, theirs: t, changedBy, start: changedBy === "theirs" ? "theirs" : "mine" });
  };
  for (const part of diffArrays(blocksOf(mine), blocksOf(theirs))) {
    if (!part.added && !part.removed) {
      settle();
      out.push({ kind: "same", blocks: part.value });
      continue;
    }
    pending ??= { mine: [], theirs: [] };
    if (part.removed) pending.mine.push(...part.value);
    else pending.theirs.push(...part.value);
  }
  settle();
  return out;
}

