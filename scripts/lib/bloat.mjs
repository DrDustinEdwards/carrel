// @ts-nocheck (plain Node scripts, exercised by test/bloat.test.ts; the repo has no types for them yet)
// Logic for the warn-only bloat report (scripts/check-bloat.mjs): the readers for Knip's and jscpd's
// JSON, the baseline comparison and the summary text. Pure functions with no file access, so
// test/bloat.test.ts (which runs in workerd) can feed them fixtures.

const KNIP_CATEGORIES = [
  "files",
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
  "unlisted",
  "binaries",
  "unresolved",
  "exports",
  "nsExports",
  "types",
  "nsTypes",
  "enumMembers",
  "classMembers",
  "duplicates",
];

/** Counts by category from Knip's `--reporter json` output, exactly as Knip groups them. */
export function knipCounts(report) {
  const counts = Object.fromEntries(KNIP_CATEGORIES.map((c) => [c, 0]));
  // Knip 6's JSON has one entry per file in `issues`; an unused file is an entry with a `files` array.
  for (const issue of report.issues ?? []) {
    for (const category of KNIP_CATEGORIES) {
      if (Array.isArray(issue[category])) counts[category] += issue[category].length;
    }
  }
  return counts;
}

/** The totals from jscpd's JSON report. */
export function jscpdTotals(report) {
  const total = report.statistics?.total;
  if (!total) throw new Error("jscpd report has no statistics.total");
  return {
    percentage: total.percentage,
    clones: total.clones,
    duplicatedLines: total.duplicatedLines,
    lines: total.lines,
  };
}

/** One line per metric that is worse than the baseline, and a count of those that are not. */
export function compareToBaseline(current, baseline) {
  const worse = [];
  let same = 0;
  const check = (label, now, before) => {
    if (before === undefined) return;
    if (now > before) worse.push(`${label}: ${before} to ${now} (+${round(now - before)})`);
    else same += 1;
  };
  for (const [key, now] of Object.entries(current.knip ?? {})) {
    check(`Knip ${key}`, now, baseline.knip?.[key]);
  }
  check("jscpd clones", current.jscpd?.clones, baseline.jscpd?.clones);
  check("jscpd duplication percent", current.jscpd?.percentage, baseline.jscpd?.percentage);
  return { worse, notWorse: same };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** The markdown posted to the job log. Warn-only: it states numbers and never a verdict.
 * @param {{knip?: any, jscpd?: any, baseline?: any, notes?: string[]}} input
 */
export function renderSummary({ knip, jscpd, baseline, notes }) {
  const out = ["## Bloat report (warn-only, never blocks a merge)", ""];
  for (const note of notes ?? []) out.push(`Note: ${note}`);
  if (notes?.length) out.push("");
  out.push("### Knip (counts by category, as Knip reports them)");
  out.push(knip ? table(Object.entries(knip).map(([k, n]) => [k, String(n)]), ["Category", "Count"]) : "Knip did not run.");
  out.push("", "### jscpd");
  out.push(
    jscpd
      ? `${jscpd.clones} clones, ${jscpd.duplicatedLines} duplicated lines of ${jscpd.lines} (${jscpd.percentage}%).`
      : "jscpd did not run.",
  );
  if (baseline && (knip || jscpd)) {
    const { worse, notWorse } = compareToBaseline({ knip, jscpd }, baseline);
    out.push("", "### Against the baseline (docs/bloat-baseline.json)");
    out.push(
      worse.length
        ? worse.map((w) => `- ${w}`).join("\n") + `\n\n${notWorse} other metrics are the same or lower.`
        : `Nothing is above the baseline (${notWorse} metrics compared).`,
    );
  }
  return out.join("\n") + "\n";
}

function table(rows, head) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}
