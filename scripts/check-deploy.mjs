// Proves scripts/deploy.mjs never puts code live after a failed step. A stub stands in for wrangler
// and for the build; each case runs the real script in a scratch copy of the config template and
// asserts on the stub's call log and the exit code.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const D1 = "11111111-2222-4333-8444-555555555555";
const KV = "0123456789abcdef0123456789abcdef";
const GOOD = { CARREL_D1_DATABASE_ID: D1, CARREL_KV_OAUTH_ID: KV, CARREL_ALERT_EMAIL: "owner@test.invalid" };

const wranglerStub = `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, "wrangler " + args.join(" ") + "\\n");
const e = process.env;
if (args[0] === "d1" && args[1] === "list") {
  console.log(JSON.stringify([{ uuid: e.STUB_D1_ID, name: "carrel" }, { uuid: "x", name: "other" }]));
} else if (args[0] === "kv") {
  console.log(JSON.stringify([{ id: e.STUB_KV_ID, title: "carrel-oauth" }, { id: "y", title: "OAUTH_KV" }]));
} else if (args[1] === "migrations" && args[2] === "apply") {
  if (e.STUB_FAIL === "migrate") { console.error("migration 0009 failed"); process.exit(1); }
} else if (args[1] === "migrations" && args[2] === "list") {
  console.log(e.STUB_PENDING === "1" ? "1 migration pending" : "No migrations to apply!");
} else if (args[0] === "deploy") {
  if (e.STUB_FAIL === "deploy") process.exit(1);
}
`;
const buildStub = `
require("node:fs").appendFileSync(process.env.STUB_LOG, "build\\n");
if (process.env.STUB_FAIL === "build") process.exit(1);
`;

const dir = mkdtempSync(join(tmpdir(), "carrel-deploy-"));
writeFileSync(join(dir, "wrangler-stub.cjs"), wranglerStub);
writeFileSync(join(dir, "build-stub.cjs"), buildStub);

/**
 * Runs deploy.mjs in a fresh scratch project. Returns the exit code, the calls made and the config.
 * @param {Record<string, string>} env @param {{ realConfig?: boolean }} [opts]
 */
function attempt(env, { realConfig = false } = {}) {
  const proj = mkdtempSync(join(dir, "proj-"));
  copyFileSync(join(repo, "wrangler.jsonc.example"), join(proj, "wrangler.jsonc.example"));
  copyFileSync(join(repo, "wrangler.jsonc.example"), join(proj, "wrangler.jsonc"));
  if (realConfig) writeFileSync(join(proj, "wrangler.jsonc"), "{ /* a real config */ }\n");
  const log = join(proj, "calls.log");
  const result = spawnSync(process.execPath, [join(repo, "scripts", "deploy.mjs")], {
    env: {
      PATH: process.env.PATH,
      CARREL_ROOT: proj,
      WRANGLER_ENTRY: join(dir, "wrangler-stub.cjs"),
      BUILD_ENTRY: join(dir, "build-stub.cjs"),
      STUB_LOG: log,
      STUB_D1_ID: D1,
      STUB_KV_ID: KV,
      ...env,
    },
    encoding: "utf8",
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  return { code: result.status, calls, stderr: result.stderr, config: readFileSync(join(proj, "wrangler.jsonc"), "utf8") };
}

/** @type {string[]} */
const failures = [];
/** @param {string} name @param {boolean} ok @param {string} detail */
function expect(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}
/** @typedef {{ calls: string[] }} Run */
/** @param {Run} r */
const deployed = (r) => r.calls.some((c) => c.startsWith("wrangler deploy"));
/** @param {Run} r @param {string} prefix */
const idx = (r, prefix) => r.calls.findIndex((c) => c.startsWith(prefix));

{
  const r = attempt(GOOD);
  const m = idx(r, "wrangler d1 migrations apply DB --remote");
  const d = idx(r, "wrangler deploy");
  expect("success: exits 0", r.code === 0, `exit ${r.code}: ${r.stderr}`);
  expect("success: migrations apply runs, then deploy", m >= 0 && d > m, JSON.stringify(r.calls));
  expect("success: build runs before migrations", idx(r, "build") >= 0 && idx(r, "build") < m, JSON.stringify(r.calls));
  expect(
    "success: rendered config has the real ids, email and both routes",
    r.config.includes(D1) &&
      r.config.includes(KV) &&
      r.config.includes('"ALERT_EMAIL": "owner@test.invalid"') &&
      /^\s*"routes": \[/m.test(r.config) &&
      r.config.includes('"pattern": "carrel-mcp.dustinedwards.info"') &&
      !r.config.includes("00000000") &&
      !r.config.includes("example.com"),
    r.config.slice(0, 400),
  );
}
{
  const r = attempt({ ...GOOD, STUB_FAIL: "migrate" });
  expect("failed migration: exit is nonzero", r.code !== 0, `exit ${r.code}`);
  expect("failed migration: deploy never runs", !deployed(r), JSON.stringify(r.calls));
}
{
  const r = attempt({ ...GOOD, STUB_PENDING: "1" });
  expect("migrations still pending: exit nonzero and deploy never runs", r.code !== 0 && !deployed(r), JSON.stringify(r.calls));
}
{
  const r = attempt({ ...GOOD, STUB_FAIL: "build" });
  expect(
    "failed build: no migration applied, no deploy",
    r.code !== 0 && !deployed(r) && idx(r, "wrangler d1 migrations apply") < 0,
    JSON.stringify(r.calls),
  );
}
{
  const r = attempt({ ...GOOD, STUB_FAIL: "deploy" });
  expect("failed deploy: exit is nonzero", r.code !== 0, `exit ${r.code}`);
}
/** @type {[string, Record<string, string>][]} */
const refusals = [
  ["no variables", {}],
  ["placeholder D1 id", { ...GOOD, CARREL_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000000" }],
  ["placeholder KV id", { ...GOOD, CARREL_KV_OAUTH_ID: "00000000000000000000000000000000" }],
  ["placeholder email", { ...GOOD, CARREL_ALERT_EMAIL: "alerts@example.com" }],
];
for (const [label, env] of refusals) {
  const r = attempt(env);
  expect(`${label}: refuses before any wrangler call`, r.code !== 0 && r.calls.length === 0, `exit ${r.code} ${JSON.stringify(r.calls)}`);
}
{
  const r = attempt({ ...GOOD, STUB_D1_ID: "99999999-2222-4333-8444-555555555555" });
  expect(
    "D1 id that is not the one named carrel: refuses, no migration, no deploy",
    r.code !== 0 && idx(r, "wrangler d1 migrations") < 0 && !deployed(r),
    JSON.stringify(r.calls),
  );
}
{
  const r = attempt({ ...GOOD, STUB_KV_ID: "ffffffffffffffffffffffffffffffff" });
  expect("KV id that is not the one titled carrel-oauth: refuses, no deploy", r.code !== 0 && !deployed(r), JSON.stringify(r.calls));
}
{
  const r = attempt(GOOD, { realConfig: true });
  expect(
    "an existing real config is never overwritten",
    r.code !== 0 && r.config.includes("a real config") && r.calls.length === 0,
    `exit ${r.code}`,
  );
}

if (failures.length) {
  console.error(`check:deploy: ${failures.length} failed.\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("check:deploy: every case behaved.");
