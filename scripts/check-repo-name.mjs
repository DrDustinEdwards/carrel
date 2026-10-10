// Proves Carrel names the long-form writing repo DrDustinEdwards/writing and nowhere the old
// DrDustinEdwards/novels. Scans every tracked file; a planted stale line must be caught first, so a
// scanner that stopped matching cannot pass quietly.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const STALE = /DrDustinEdwards\\?\/novels\b/;
const SELF = "scripts/check-repo-name.mjs";

const planted = ["fetch https://api.github.com/repos/DrDustinEdwards/novels/contents", String.raw`/^\/repos\/DrDustinEdwards\/novels\/x$/`];
if (!planted.every((line) => STALE.test(line))) {
  console.error("FAIL planted stale name was not matched; the scanner is broken.");
  process.exit(1);
}

const failures = [];
const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of files) {
  if (file === SELF || file.startsWith("docs/research/")) continue;
  let text;
  try {
    text = readFileSync(join(repo, file), "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    if (STALE.test(line)) failures.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

const source = readFileSync(join(repo, "app/lib/novels/repo.server.ts"), "utf8");
if (!source.includes('export const NOVELS_REPO = "DrDustinEdwards/writing";')) {
  failures.push("app/lib/novels/repo.server.ts: NOVELS_REPO is not DrDustinEdwards/writing");
}

if (failures.length) {
  console.error(`FAIL the old repo name is still used:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`ok: ${files.length} tracked files name DrDustinEdwards/writing and not DrDustinEdwards/novels.`);
