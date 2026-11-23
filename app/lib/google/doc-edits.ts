// A book file's words against a Google Doc's: the smallest edits that carry the Doc to the file.

import type { JsonDoc } from "capsomer/behavior/collab-editor";

import type { EditAsked, Para } from "./docs.server";

export type Mark = { type: string; attrs?: Record<string, unknown> };

/** A Google suggestion's id in Carrel, so a send knows which suggestions came from the Doc. */
export const GOOGLE = "gdocs:";

const isGoogle = (m: Mark) => String(m.attrs?.id ?? "").startsWith(GOOGLE);

/**
 * Each text block's words as the file proposes them: Carrel's own suggestions taken, Google's still pending left as
 * the Doc has them (an insertion out, a deletion in), so only what Carrel changed differs from the Doc.
 */
export function proposedText(doc: JsonDoc): { blocks: string[]; pending: Set<string> } {
  const blocks: string[] = [];
  const pending = new Set<string>();
  const keeps = (marks: Mark[] | undefined) => {
    for (const m of marks ?? []) {
      if (m.type !== "insertion" && m.type !== "deletion") continue;
      if (isGoogle(m)) pending.add(String(m.attrs!.id).slice(GOOGLE.length));
      if (m.type === "insertion") return !isGoogle(m);
      return isGoogle(m);
    }
    return true;
  };
  const inline = (n: JsonDoc): string => {
    if (n.type === "text") return keeps(n.marks) ? (n.text ?? "") : "";
    if (n.type === "hardBreak") return keeps(n.marks) ? "\u000b" : "";
    if (n.type === "sourceInline") return String(n.attrs?.text ?? "");
    return (n.content ?? []).map(inline).join("");
  };
  const walk = (n: JsonDoc) => {
    const own = n.marks ?? (n.attrs?.smark ? (JSON.parse(String(n.attrs.smark)) as Mark[]) : []);
    if (!keeps(own)) {
      // A block left out still names the Google suggestions inside it as pending.
      for (const id of proposedText({ type: "doc", content: n.content ?? [] }).pending)
        pending.add(id);
      return;
    }
    if (n.type === "paragraph" || n.type === "heading") {
      const text = (n.content ?? []).map(inline).join("");
      if (text) blocks.push(text);
    } else if (n.type === "sourceBlock") {
      if (n.attrs?.kind !== "Front matter" && n.attrs?.text) blocks.push(String(n.attrs.text));
    } else (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return { blocks, pending };
}

/** A Doc paragraph's words with its pending suggestions as they stand (insertions out), `taken` accepted. */
export function paraWords(p: Para, taken: ReadonlySet<string> = new Set()): string {
  return p.segs
    .map((s) => {
      const mine = (s.ids ?? []).some((id) => taken.has(id));
      if (s.state === "plain") return s.text;
      if (s.state === "deleted") return mine ? "" : s.text;
      if (s.state === "inserted") return mine ? s.text : "";
      return "";
    })
    .join("")
    .replace(/\n$/, "");
}

/** How often `quote` appears inside the paragraphs (never across two). */
function count(paras: string[], quote: string): number {
  let n = 0;
  for (const p of paras) for (let i = p.indexOf(quote); i >= 0; i = p.indexOf(quote, i + 1)) n++;
  return n;
}

/** The longest common subsequence of two lists of paragraphs, as pairs of indexes. */
function common(a: string[], b: string[]): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const w = y.length + 1;
  const dp = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i * w + j] =
        x[i] === y[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0; i < head; i++) pairs.push([i, i]);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      pairs.push([head + i, head + j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  for (let k = 0; k < tail; k++) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

/** The start of the word `at` falls in (or `at`, at a space). */
const wordStart = (s: string, at: number) => {
  while (at > 0 && !/\s/.test(s[at - 1]!)) at--;
  return at;
};
const wordEnd = (s: string, at: number) => {
  while (at < s.length && !/\s/.test(s[at]!)) at++;
  return at;
};

/** Grows [from, to) in `p` a word at a time on each side until the words appear once among `paras`. */
function unique(paras: string[], p: string, from: number, to: number): [number, number] | null {
  for (;;) {
    const quote = p.slice(from, to);
    if (quote.trim() && count(paras, quote) === 1) return [from, to];
    if (from === 0 && to === p.length) return null;
    from = from > 0 ? wordStart(p, from - 1) : 0;
    to = to < p.length ? wordEnd(p, to + 1) : p.length;
  }
}

/** One changed paragraph as the smallest edit, with `extra` (new paragraphs after it) on its end. */
function changeOf(paras: string[], d: string, c: string, extra: string[]): EditAsked | null {
  let p = 0;
  while (p < d.length && p < c.length && d[p] === c[p]) p++;
  let s = 0;
  while (s < d.length - p && s < c.length - p && d[d.length - 1 - s] === c[c.length - 1 - s]) s++;
  p = wordStart(d, p);
  let dEnd = d.length - s;
  if (extra.length) dEnd = d.length;
  else dEnd = wordEnd(d, dEnd);
  const cEnd = c.length - (d.length - dEnd);
  const span = unique(paras, d, p, Math.max(dEnd, p));
  if (!span) return null;
  const [from, to] = span;
  const replace = d.slice(from, p) + c.slice(p, cEnd) + d.slice(dEnd, to);
  const tail = extra.length ? `\n${extra.join("\n")}` : "";
  if (to > from) return { find: d.slice(from, to), replace: replace + tail };
  return null;
}

/**
 * The edits that turn the Doc's paragraphs into the file's: each changed paragraph its smallest change, new
 * paragraphs after the one before them, a paragraph gone its words taken out.
 */
export function editsBetween(doc: string[], file: string[]): EditAsked[] {
  const pairs = common(doc, file);
  const edits: EditAsked[] = [];
  let i = 0;
  let j = 0;
  const hunk = (iEnd: number, jEnd: number) => {
    const dels = doc.slice(i, iEnd);
    const ins = file.slice(j, jEnd);
    const k = Math.min(dels.length, ins.length);
    for (let n = 0; n < k; n++) {
      const extra = n === k - 1 ? ins.slice(k) : [];
      const e = changeOf(doc, dels[n]!, ins[n]!, extra);
      if (e) edits.push(e);
    }
    if (k === 0 && ins.length) {
      const before = doc[i - 1];
      const after = doc[iEnd];
      if (before !== undefined) {
        const span = unique(
          doc,
          before,
          wordStart(before, Math.max(0, before.length - 1)),
          before.length,
        );
        if (span)
          edits.push({ insert_after: before.slice(span[0], span[1]), text: `\n${ins.join("\n")}` });
      } else if (after !== undefined) {
        const span = unique(doc, after, 0, wordEnd(after, 0));
        if (span) {
          const words = after.slice(span[0], span[1]);
          edits.push({ find: words, replace: `${ins.join("\n")}\n${words}` });
        }
      }
    }
    for (const gone of dels.slice(k))
      if (gone.trim() && count(doc, gone) === 1) edits.push({ find: gone, replace: "" });
  };
  for (const [a, b] of pairs) {
    if (a > i || b > j) hunk(a, b);
    i = a + 1;
    j = b + 1;
  }
  if (i < doc.length || j < file.length) hunk(doc.length, file.length);
  return edits;
}
