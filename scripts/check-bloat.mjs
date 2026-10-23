// @ts-nocheck (plain Node scripts, exercised by test/bloat.test.ts; the repo has no types for them yet)
// A warn-only report on dead code (Knip) and duplicated code (jscpd). `npm run check:bloat` runs it,
// then builds and runs devkit-route-weight for the weight per route against .route-weight.json.
// This report always exits 0: the numbers are defaults to watch, never a gate (capsid/decisions.md,
// "no bloat, as a standing plan").
// In CI the summary also goes to the step summary file. Knip and jscpd run at exact versions through
// npx so package.json and the lockfile do not carry them.
//
//   node scripts/check-bloat.mjs                  run both, print the summary
//   node scripts/check-bloat.mjs --json out.json  also write the measured numbers (the baseline shape)
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jscpdTotals, knipCounts, renderSummary } from "./lib/bloat.mjs";

const KNIP_VERSION = "6.39.0";
const JSCPD_VERSION = "5.4.0";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const shell = process.platform === "win32";
const notes = [];

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", shell, maxBuffer: 256 * 1024 * 1024, ...options });
}

function measure(name, fn) {
  try {
    return fn();
  } catch (error) {
    const message = `${name} failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    notes.push(message);
    return null;
  }
}

const baseline = existsSync("docs/bloat-baseline.json")
  ? JSON.parse(readFileSync("docs/bloat-baseline.json", "utf8"))
  : null;

const knip = measure("Knip", () => {
  // --no-exit-code: Knip exits 1 when it finds issues, and finding them is not a failure here.
  const result = run("npx", ["--yes", `knip@${KNIP_VERSION}`, "--reporter", "json", "--no-exit-code"]);
  if (result.status !== 0) throw new Error(`exited ${result.status}: ${result.stderr.slice(0, 500)}`);
  return knipCounts(JSON.parse(result.stdout));
});

const jscpd = measure("jscpd", () => {
  const out = mkdtempSync(join(tmpdir(), "jscpd-"));
  const result = run("npx", ["--yes", `jscpd@${JSCPD_VERSION}`, "--reporters", "json", "--output", out, "--silent"]);
  if (result.status !== 0) throw new Error(`exited ${result.status}: ${result.stderr.slice(0, 500)}`);
  return jscpdTotals(JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8")));
});

const summary = renderSummary({ knip, jscpd, baseline, notes });
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ knip, jscpd }, null, 2) + "\n");
process.exit(0);
