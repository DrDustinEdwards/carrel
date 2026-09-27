// check:mcp-roles. The MCP layer holds no role logic (design decision 7, corrected; job_9ceeb5b44aa1).
//
// Every rule about who may do what lives in the functions the buttons call (content.server.ts,
// ai.server.ts, books.server.ts, people.server.ts, roles.ts). The MCP layer, app/lib/mcp/, names the
// project and the action and calls down. A role test here would be a second copy of a rule, and the
// first time the two disagreed one door would allow what the other refused.
//
// Deterministic, not judgement: comments are stripped, then each file is searched for the shapes a
// role decision takes. A hit exits 1 and names the file, line and shape. Finding no files at all
// exits 2, because a check that looked at nothing has not passed.
//
// Run: npm run check:mcp-roles

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAYER = join(ROOT, "app", "lib", "mcp");

/**
 * The shapes a role decision takes. Each is a question only the functions below the layer may ask.
 * @type {[RegExp, string][]}
 */
const FORBIDDEN = [
  [/\bisOwner\b/, "reads isOwner"],
  [/\bisReviewer\b/, "reads isReviewer"],
  [/\.role\b/, "reads a role"],
  [/\brole\s*[!=]==?/, "compares a role"],
  [/["'`](owner|editor|reader|reviewer)["'`]/, "names a role as a value"],
  [/\bcan\s*\(/, "calls can()"],
  [/\b(roleOn|requireAction|requireCan)\b/, "asks for a role directly"],
  [/from\s+["']~\/lib\/roles["']/, "imports roles.ts for anything but a type"],
];

/**
 * Lines of code with comments removed. A `//` inside a string such as a URL is left alone.
 * @param {string} source
 */
function codeLines(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (/** @type {string} */ block) => block.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"));
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const found = files(LAYER);
if (found.length === 0) {
  console.error(`check:mcp-roles: no files under ${relative(ROOT, LAYER)}; nothing was checked.`);
  process.exit(2);
}

let hits = 0;
for (const file of found) {
  codeLines(readFileSync(file, "utf8")).forEach((line, index) => {
    // A type-only import of roles.ts (the Action type) names an action, not a role.
    if (/^\s*import\s+type\b/.test(line)) return;
    for (const [pattern, shape] of FORBIDDEN) {
      if (pattern.test(line)) {
        hits += 1;
        console.error(`  ${relative(ROOT, file)}:${index + 1}  ${shape}:  ${line.trim().slice(0, 140)}`);
      }
    }
  });
}

if (hits) {
  console.error(`check:mcp-roles: ${hits} role decision(s) in the MCP layer. Move each into the function the tool calls.`);
  process.exit(1);
}
console.log(`check:mcp-roles: ${found.length} files in ${relative(ROOT, LAYER)}, no role logic.`);
