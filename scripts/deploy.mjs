// The CI deploy: render the real Worker config, check it, build, apply D1 migrations, then deploy.
//
// wrangler.jsonc is gitignored (it carries the live ids and the alert email), so a fresh clone has
// only the placeholder copy that scripts/bootstrap-config.mjs made. This script renders the real one
// from the example and these variables, and refuses to go on when any is missing or still a
// placeholder:
//
//   CARREL_D1_DATABASE_ID   id of the D1 database named `carrel`
//   CARREL_KV_OAUTH_ID      id of the KV namespace titled `carrel-oauth` (bound as OAUTH_KV)
//   CARREL_ALERT_EMAIL      the address health alerts go to
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   read by wrangler itself
//
// Order, and every step stops the run on a nonzero exit: render, check the ids against the names in
// the account, build, migrations apply, migrations list (nothing may be pending), wrangler deploy.
// The new code goes live only after the migrations are in.
//
// It overwrites wrangler.jsonc only when that file is absent or still the placeholder copy, so a
// local run can never replace a real config. It also turns on the two custom-domain routes, which the
// example keeps commented out for the first, never-public deploy.
//
// WRANGLER_ENTRY, BUILD_ENTRY and CARREL_ROOT exist for scripts/check-deploy.mjs, which stands stubs
// in for wrangler and the build.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.CARREL_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = process.env.WRANGLER_ENTRY ?? join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const build = process.env.BUILD_ENTRY ?? join(root, "node_modules", "@react-router", "dev", "bin.cjs");
const buildArgs = process.env.BUILD_ENTRY ? [] : ["build"];

const ZERO_D1 = "00000000-0000-0000-0000-000000000000";
const ZERO_KV = "00000000000000000000000000000000";
const D1_NAME = "carrel";
const KV_TITLE = "carrel-oauth";

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function step(name) {
  console.log(`deploy: ${name}`);
}

/** Runs a node script. Returns {status, stdout}; stdout is echoed unless quiet. */
function run(entry, args, { quiet = false } = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) fail(`could not start ${entry}: ${result.error.message}`);
  if (!quiet) process.stdout.write(result.stdout ?? "");
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function must(label, entry, args, opts) {
  const result = run(entry, args, opts);
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}). Stopping; nothing after it ran.`);
  return result;
}

// 1. The variables.
const d1Id = process.env.CARREL_D1_DATABASE_ID ?? "";
const kvId = process.env.CARREL_KV_OAUTH_ID ?? "";
const alertEmail = process.env.CARREL_ALERT_EMAIL ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d1Id) || d1Id === ZERO_D1) {
  fail("CARREL_D1_DATABASE_ID is missing, not a UUID, or the placeholder. Refusing to deploy.");
}
if (!/^[0-9a-f]{32}$/.test(kvId) || kvId === ZERO_KV) {
  fail("CARREL_KV_OAUTH_ID is missing, not 32 hex characters, or the placeholder. Refusing to deploy.");
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertEmail) || /@example\.com$/i.test(alertEmail)) {
  fail("CARREL_ALERT_EMAIL is missing or the placeholder. Refusing to deploy.");
}

// 2. Render wrangler.jsonc from the example.
const examplePath = join(root, "wrangler.jsonc.example");
const configPath = join(root, "wrangler.jsonc");
if (!existsSync(examplePath)) fail("wrangler.jsonc.example is missing.");
const example = readFileSync(examplePath, "utf8");
if (existsSync(configPath) && readFileSync(configPath, "utf8") !== example) {
  fail("wrangler.jsonc already exists and is not the placeholder copy. Refusing to overwrite a real config.");
}

/** Replaces `from` with `to`, which must occur exactly once in the text. */
function replaceOnce(text, from, to) {
  const parts = text.split(from);
  if (parts.length !== 2) fail(`the example has ${parts.length - 1} copies of ${JSON.stringify(from)}, expected 1.`);
  return parts.join(to);
}

let rendered = example;
rendered = replaceOnce(rendered, `"database_id": "${ZERO_D1}"`, `"database_id": "${d1Id}"`);
rendered = replaceOnce(rendered, `"id": "${ZERO_KV}"`, `"id": "${kvId}"`);
rendered = replaceOnce(rendered, `"ALERT_EMAIL": "alerts@example.com"`, `"ALERT_EMAIL": ${JSON.stringify(alertEmail)}`);
// The routes block: the lines from `// "routes": [` to `// ],`, with their comment marker removed.
const lines = rendered.split("\n");
const start = lines.findIndex((l) => l.trim() === '// "routes": [');
const end = lines.findIndex((l, i) => i > start && l.trim() === "// ],");
if (start < 0 || end < 0) fail("the example has no commented routes block to turn on.");
for (let i = start; i <= end; i++) lines[i] = lines[i].replace(/^(\s*)\/\/ ?/, "$1");
rendered = lines.join("\n");
if (rendered.includes(ZERO_D1) || rendered.includes(ZERO_KV) || rendered.includes("example.com")) {
  fail("the rendered config still holds a placeholder. Refusing to deploy.");
}
step("rendering wrangler.jsonc from the example");
writeFileSync(configPath, rendered);

// 3. The ids must be the ones the names resolve to in this account.
step(`checking database "${D1_NAME}" and namespace "${KV_TITLE}" against the account`);
const d1List = must("wrangler d1 list", wrangler, ["d1", "list", "--json"], { quiet: true });
let databases;
try {
  databases = JSON.parse(d1List.stdout);
} catch {
  fail("wrangler d1 list did not return JSON.");
}
const d1Match = databases.filter((d) => d.name === D1_NAME);
if (d1Match.length !== 1 || d1Match[0].uuid !== d1Id) {
  fail(`the D1 database named "${D1_NAME}" does not have the id in CARREL_D1_DATABASE_ID. Refusing to deploy.`);
}
const kvList = must("wrangler kv namespace list", wrangler, ["kv", "namespace", "list"], { quiet: true });
let namespaces;
try {
  namespaces = JSON.parse(kvList.stdout);
} catch {
  fail("wrangler kv namespace list did not return JSON.");
}
const kvMatch = namespaces.filter((n) => n.title === KV_TITLE);
if (kvMatch.length !== 1 || kvMatch[0].id !== kvId) {
  fail(`the KV namespace titled "${KV_TITLE}" does not have the id in CARREL_KV_OAUTH_ID. Refusing to deploy.`);
}

// 4. Build, so a broken build stops the run before any migration is applied.
step("building");
must("the build", build, buildArgs);

// 5. Migrations, then proof that none is pending. A failure here ends the run before the deploy.
step("applying remote D1 migrations");
must("the D1 migrations", wrangler, ["d1", "migrations", "apply", "DB", "--remote"]);
step("checking that no migration is pending");
const pending = must("wrangler d1 migrations list", wrangler, ["d1", "migrations", "list", "DB", "--remote"]);
if (!/No migrations to apply/i.test(pending.stdout)) fail("migrations are still pending after the apply. Refusing to deploy.");

// 6. The new code goes live.
step("deploying");
must("wrangler deploy", wrangler, ["deploy"]);
console.log("deploy: done. Migrations applied, none pending, Worker deployed.");
