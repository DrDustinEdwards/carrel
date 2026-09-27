// check:conformance. Runs the OFFICIAL MCP conformance suite (@modelcontextprotocol/conformance)
// against Carrel's real protocol layer and its real AI door, as dustinedwards-mcp does.
//
// TWO ERAS, ASSERTED SEPARATELY. The 2026-07-28 run certifies the design-center era. The 2025-11-25
// run certifies the shim in app/lib/mcp/legacy-era.ts, so the compatibility path is proven rather than
// assumed, and the day the shim is deleted this gate says what stopped working.
//
// PLUS THE AUTHORIZATION SERVER. A second dev process mounts the real door (test/conformance/
// auth-entry.ts) and the suite's authorization-server-metadata-endpoint scenario runs against it. On
// top of it the harness pins the door's one client-identity path in both directions: CIMD advertised,
// and NO registration endpoint (Carrel is CIMD only; a client cannot mint itself an identity here).
//
// COUNTS, NOT PASS/FAIL. A scenario with a recorded baseline must not regress, and a count that
// improves fails too, so the baseline gets tightened. Demanding 100% would be a permanently red gate
// on upstream SDK gaps; asserting nothing would be a gate that cannot notice the protocol breaking.
//
// SCOPE. Carrel's MCP implements tools and nothing else, so resource, prompt, completion, logging,
// sampling and elicitation scenarios are not run.
//
// Runs locally, never on Actions (minutes are limited; design section 7).
//
// Run: npm run check:conformance

import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const CONFORMANCE = fileURLToPath(new URL("../node_modules/@modelcontextprotocol/conformance/dist/index.js", import.meta.url));
const CONFIG = "test/conformance/wrangler.jsonc";

const DEV_PORT = 8789;
const AUTH_PORT = 8791;

/**
 * Scenarios with their RECORDED PASS COUNTS, measured on this repo on 2026-09-27 against
 * @modelcontextprotocol/server 2.0.0 through agents 0.24.0. A null baseline must pass every check.
 */
/** @type {[string, string, number | null, number | null, string | null][]} */
const SCENARIOS = [
  // spec version, scenario, expected passes, expected total, note
  //
  // server-stateless 24/28, the four read from this repo's run: two checks need
  // MissingRequiredClientCapabilityError (-32021), which SDK 2.0.0 does not implement (the same two
  // dustinedwards-mcp records); two call the suite's diagnostic tools (test_streaming_elicitation,
  // test_logging_tool), which Carrel does not expose, so the suite marks them untestable.
  ["2026-07-28", "server-stateless", 24, 28, "2 upstream (-32021), 2 untestable (suite diagnostic tools)"],
  ["2026-07-28", "http-header-validation", null, null, null],
  ["2025-11-25", "server-initialize", null, null, null],
];

let failures = 0;
/** @param {string} s */
const log = (s) => process.stdout.write(`${s}\n`);

/** @param {string[]} args */
function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * @param {string} entry
 * @param {number} port
 * @param {string} persist
 * @param {string[]} [vars]
 */
function devServer(entry, port, persist, vars = []) {
  const child = spawn(
    process.execPath,
    [WRANGLER, "dev", entry, "-c", CONFIG, "--port", String(port), "--persist-to", persist, ...vars.flatMap((v) => ["--var", v])],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return { child, output: () => output };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function waitFor(url, init, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      if (res.status > 0) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

/** @param {string[]} args */
function run(args) {
  try {
    // Per-scenario timeout: one hanging scenario must not hang the gate.
    return { ok: true, out: execFileSync(process.execPath, [CONFORMANCE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }) };
  } catch (err) {
    const e = /** @type {{ stdout?: string; stderr?: string }} */ (err);
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** @param {string} out */
function summarize(out) {
  const m = out.match(/Passed:\s*(\d+)\/(\d+)/);
  if (m) return { passed: Number(m[1]), total: Number(m[2]) };
  const s = out.match(/Total:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (s) return { passed: Number(s[1]), total: Number(s[1]) + Number(s[2]) };
  return null;
}

// The protocol layer's tools read D1, so the local database gets the same migrations a deploy applies.
wrangler(["d1", "migrations", "apply", "DB", "--local", "-c", CONFIG, "--persist-to", ".wrangler/state-conformance"]);

const dev = devServer("test/conformance/entry.ts", DEV_PORT, ".wrangler/state-conformance");
// Its own --persist-to: two dev processes on one state directory die at SQLITE_BUSY (measured in
// dustinedwards-mcp, 2026-09-07).
const authDev = devServer("test/conformance/auth-entry.ts", AUTH_PORT, ".wrangler/state-conformance-auth", [`CARREL_MCP_ORIGIN:http://localhost:${AUTH_PORT}`]);

function shutdown() {
  for (const p of [dev.child, authDev.child]) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", shutdown);

if (!(await waitFor(`http://localhost:${DEV_PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))) {
  log("wrangler dev (protocol) did not come up. Output follows:");
  log(dev.output().slice(-3000));
  process.exit(2);
}
log(`wrangler dev on :${DEV_PORT} against the real protocol layer\n`);

for (const [specVersion, scenario, wantPass, wantTotal, note] of SCENARIOS) {
  const { ok, out } = run(["server", "--url", `http://localhost:${DEV_PORT}/mcp`, "--scenario", scenario, "--spec-version", specVersion]);
  const counts = summarize(out);
  const label = `${specVersion}  ${scenario}`;
  // Judged on the parsed count, not the exit code: on Windows the suite can abort in teardown after
  // printing its results (measured in dustinedwards-mcp), so the exit code alone misreports.
  const crash = ok ? "" : "  [suite exited non-zero]";
  if (!counts) {
    failures += 1;
    log(`  NO RESULT  ${label}  (could not parse a count from the suite output)`);
    log(out.slice(-1500));
    continue;
  }
  const failing = () => out.split("\n").filter((l) => /FAIL/.test(l)).slice(0, 8).forEach((l) => log(`               ${l.trim().slice(0, 170)}`));
  if (wantPass === null) {
    if (counts.passed === counts.total) log(`  PASS       ${label}  (${counts.passed}/${counts.total})${crash}`);
    else {
      failures += 1;
      log(`  FAIL       ${label}  (${counts.passed}/${counts.total})`);
      failing();
    }
    continue;
  }
  if (counts.total !== wantTotal) {
    failures += 1;
    log(`  RECOUNT    ${label}  total moved ${wantTotal} -> ${counts.total}; the suite changed, re-baseline`);
  } else if (counts.passed < wantPass) {
    failures += 1;
    log(`  REGRESSED  ${label}  ${counts.passed}/${counts.total}, baseline ${wantPass}`);
    failing();
  } else if (counts.passed > wantPass) {
    failures += 1;
    log(`  IMPROVED   ${label}  ${counts.passed}/${counts.total} beats baseline ${wantPass}; tighten it`);
  } else {
    log(`  BASELINE   ${label}  ${counts.passed}/${counts.total}${note ? `  (${note})` : ""}${crash}`);
    // The known failures, printed so the note above stays a measurement rather than a memory.
    failing();
  }
}

// ---- the authorization server, against the real door

if (!(await waitFor(`http://localhost:${AUTH_PORT}/.well-known/oauth-authorization-server`))) {
  failures += 1;
  log("  FAIL       authorization: wrangler dev on the door did not come up. Output follows:");
  log(authDev.output().slice(-3000));
} else {
  const label = "2026-07-28  authorization-server-metadata-endpoint";
  const auth = run(["authorization", "--url", `http://localhost:${AUTH_PORT}`, "--scenario", "authorization-server-metadata-endpoint", "--spec-version", "2026-07-28"]);
  const counts = summarize(auth.out);
  if (!counts) {
    failures += 1;
    log(`  NO RESULT  ${label}`);
    log(auth.out.slice(-1500));
  } else if (counts.passed === counts.total) {
    log(`  PASS       ${label}  (${counts.passed}/${counts.total})${auth.ok ? "" : "  [suite exited non-zero]"}`);
  } else {
    failures += 1;
    log(`  FAIL       ${label}  (${counts.passed}/${counts.total})`);
  }

  // The official scenario treats registration as optional, so it cannot notice either direction of
  // the door's one rule. These pin it.
  const meta = /** @type {Record<string, unknown>} */ (await (await fetch(`http://localhost:${AUTH_PORT}/.well-known/oauth-authorization-server`)).json());
  if (meta.client_id_metadata_document_supported === true) log("  PASS       metadata advertises CIMD (the path claude.ai and Claude Code take)");
  else {
    failures += 1;
    log("  FAIL       metadata does not advertise client_id_metadata_document_supported");
  }
  if (meta.registration_endpoint === undefined) log("  PASS       metadata advertises no registration endpoint (CIMD only)");
  else {
    failures += 1;
    log(`  FAIL       metadata advertises registration_endpoint ${meta.registration_endpoint}; the door is CIMD only`);
  }
  const reg = await fetch(`http://localhost:${AUTH_PORT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "check-conformance", redirect_uris: ["http://127.0.0.1:3000/callback"], token_endpoint_auth_method: "none" }),
  });
  if (reg.status === 404) log("  PASS       POST /register mints nothing (404)");
  else {
    failures += 1;
    log(`  FAIL       POST /register answered ${reg.status}; no client may register itself`);
  }
  const unauth = await fetch(`http://localhost:${AUTH_PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (unauth.status === 401 && (unauth.headers.get("www-authenticate") ?? "").includes("resource_metadata=")) log("  PASS       /mcp without a token answers 401 with a resource_metadata challenge");
  else {
    failures += 1;
    log(`  FAIL       /mcp without a token answered ${unauth.status} (${unauth.headers.get("www-authenticate")})`);
  }
}

log("");
shutdown();
if (failures) {
  log(`check:conformance: ${failures} check(s) failed.`);
  process.exit(1);
}
log("check:conformance: no regression against the recorded baseline in either era, and the door serves CIMD and nothing else.");
