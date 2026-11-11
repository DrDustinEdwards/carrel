// The `:::chart` blocks already in a post's text, for the chart check (E4). Pure, shared by the
// browser and the tests. The syntax is Prelum's (README, "Charts in posts"); the insert dialog that
// writes one is Capsomer's chart builder.

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
