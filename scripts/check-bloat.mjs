// `npm run check:bloat`: a warn-only report on dead code (Knip), duplicated code (jscpd) and
// JavaScript and CSS weight per route. It always exits 0: the numbers are defaults to watch, never
// a gate (capsid/decisions.md, "no bloat, as a standing plan"). In CI the summary also goes to the
// step summary file. Knip and jscpd run at exact versions through npx so package.json and the
// lockfile do not carry them.
//
//   node scripts/check-bloat.mjs                  build, run all three, print the summary
//   node scripts/check-bloat.mjs --no-build       reuse an existing build/client
//   node scripts/check-bloat.mjs --json out.json  also write the measured numbers (the baseline shape)
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { jscpdTotals, knipCounts, pageWeight, parseManifest, renderSummary } from "./lib/bloat.mjs";

const KNIP_VERSION = "6.40.0";
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

const routes = measure("page weight", () => {
  if (!args.includes("--no-build")) {
    const build = run("npm", ["run", "build"], { stdio: ["ignore", "ignore", "inherit"] });
    if (build.status !== 0) throw new Error(`npm run build exited ${build.status}`);
  }
  const clientDir = "build/client";
  const assets = join(clientDir, "assets");
  const names = readdirSync(assets).filter((n) => /^manifest-.*.js$/.test(n));
  if (names.length !== 1) throw new Error(`expected one manifest-*.js in ${assets}, found ${names.length}`);
  const manifest = parseManifest(readFileSync(join(assets, names[0]), "utf8"));
  const gzip = (bytes) => gzipSync(bytes, { level: 9 }).length;
  return pageWeight(manifest, (file) => readFileSync(join(clientDir, file)), gzip);
});

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

const summary = renderSummary({ knip, jscpd, routes, baseline, notes });
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ knip, jscpd, routes }, null, 2) + "\n");
process.exit(0);
