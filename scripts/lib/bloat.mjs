// Logic for the warn-only bloat report (scripts/check-bloat.mjs): the page-weight reader, the
// readers for Knip's and jscpd's JSON, the baseline comparison and the summary text. Pure
// functions with no file access, so test/bloat.test.ts (which runs in workerd) can feed them fixtures.

/**
 * Parse the text of the React Router client manifest (build/client/assets/manifest-*.js).
 */
export function parseManifest(text) {
  const prefix = "window.__reactRouterManifest=";
  if (!text.startsWith(prefix)) throw new Error(`the manifest does not start with ${prefix}`);
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ""));
}

/**
 * JavaScript and CSS gzip weight per route: what a browser loads for a first visit to that route.
 * That is the client entry, then the route modules from root down to the route, each with its
 * imports and CSS, each file counted once. Fonts and images are not counted. A route with no
 * default export (a resource route) loads no page, so it is left out. `read(path)` returns the
 * bytes of a file given as "/assets/name.js", and `gzip(bytes)` returns the compressed size.
 */
export function pageWeight(manifest, read, gzip) {
  const sizes = new Map();
  const gz = (file) => {
    if (!sizes.has(file)) sizes.set(file, gzip(read(file)));
    return sizes.get(file);
  };
  const routes = [];
  for (const route of Object.values(manifest.routes)) {
    if (!route.hasDefaultExport) continue;
    const chain = [];
    for (let r = route; r; r = manifest.routes[r.parentId]) chain.unshift(r);
    const js = new Set([manifest.entry.module, ...manifest.entry.imports]);
    const css = new Set(manifest.entry.css);
    for (const r of chain) {
      js.add(r.module);
      for (const f of r.imports) js.add(f);
      for (const f of r.css) css.add(f);
    }
    routes.push({
      id: route.id,
      path: fullPath(manifest, route),
      jsFiles: js.size,
      cssFiles: css.size,
      jsGzip: [...js].reduce((n, f) => n + gz(f), 0),
      cssGzip: [...css].reduce((n, f) => n + gz(f), 0),
    });
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return routes;
}

function fullPath(manifest, route) {
  const parts = [];
  for (let r = route; r; r = manifest.routes[r.parentId]) if (r.path) parts.unshift(r.path);
  return "/" + parts.join("/");
}

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
  counts.files = (report.files ?? []).length;
  for (const issue of report.issues ?? []) {
    for (const category of KNIP_CATEGORIES) {
      if (category !== "files" && Array.isArray(issue[category])) {
        counts[category] += issue[category].length;
      }
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
  const before = new Map((baseline.routes ?? []).map((r) => [r.id, r]));
  for (const r of current.routes ?? []) {
    const b = before.get(r.id);
    if (!b) {
      worse.push(`route ${r.id}: new, ${r.jsGzip} B JS and ${r.cssGzip} B CSS gzip`);
      continue;
    }
    check(`route ${r.id} JS gzip bytes`, r.jsGzip, b.jsGzip);
    check(`route ${r.id} CSS gzip bytes`, r.cssGzip, b.cssGzip);
  }
  return { worse, notWorse: same };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** The markdown posted to the job log. Warn-only: it states numbers and never a verdict. */
export function renderSummary({ knip, jscpd, routes, baseline, notes }) {
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
  out.push("", "### JavaScript and CSS weight per route (gzip, bytes)");
  out.push(
    routes
      ? table(routes.map((r) => [r.id, String(r.jsGzip), String(r.cssGzip)]), ["Route", "JS", "CSS"])
      : "Page weight did not run.",
  );
  if (baseline && (knip || jscpd || routes)) {
    const { worse, notWorse } = compareToBaseline({ knip, jscpd, routes }, baseline);
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
