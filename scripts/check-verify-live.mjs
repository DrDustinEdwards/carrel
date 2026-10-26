// Proves scripts/verify-live.mjs, the live gate's verify, refuses (exit 1) on each planted break, says
// "could not run" (exit 3) when nothing answers, and passes (exit 0) a healthy Carrel. Two local servers
// stand in for the AI door and the browser host; each case runs the real script against them.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "verify-live.mjs");
const SHA = "4df127439ed3aa19aef8e350ab6311957b8f8611";

/** The healthy answers, each a plant can replace. */
const healthy = () => ({
  health: { status: 200, body: JSON.stringify({ ok: true, sha: SHA }) },
  metadata: { status: 200, body: "" },
  mcp: { status: 401, body: "" },
  unknown: { status: 404, body: "Not found." },
  browser: { status: 302, location: "https://dustinedwards.cloudflareaccess.com/cdn-cgi/access/login/desk.dustinedwards.info" },
});

/** @type {ReturnType<typeof healthy>} */
let answers = healthy();

/** @param {(req: import("node:http").IncomingMessage) => { status: number, body?: string, location?: string }} pick */
async function serve(pick) {
  const server = createServer((req, res) => {
    req.resume();
    const a = pick(req);
    res.writeHead(a.status, a.location ? { Location: a.location } : { "Content-Type": "application/json" });
    res.end(a.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

const mcp = await serve((req) => {
  if (req.url === "/health") return answers.health;
  if (req.url === "/.well-known/oauth-authorization-server") return { ...answers.metadata, body: answers.metadata.body || JSON.stringify({ issuer: mcp.origin }) };
  if (req.url === "/mcp") return answers.mcp;
  return answers.unknown;
});
const browser = await serve(() => answers.browser);

/** @param {Record<string, string>} env @returns {Promise<{ code: number | null, out: string }>} */
function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { PATH: process.env.PATH, VERIFY_RETRY_MS: "0", CARREL_MCP_ORIGIN: mcp.origin, CARREL_ORIGIN: browser.origin, EXPECT_SHA: SHA, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** @type {string[]} */
const failures = [];
/** @param {string} name @param {Partial<ReturnType<typeof healthy>>} plant @param {number} want @param {Record<string, string>} [env] */
async function expectCase(name, plant, want, env = {}) {
  answers = { ...healthy(), ...plant };
  const { code, out } = await run(env);
  const ok = code === want;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures.push(`${name}: wanted exit ${want}, got ${code}\n${out}`);
}

await expectCase("a healthy Carrel passes", {}, 0);
await expectCase("an abbreviated sha on /health passes", { health: { status: 200, body: JSON.stringify({ sha: SHA.slice(0, 8) }) } }, 0);
await expectCase("a 401 from Access on the browser host passes", { browser: { status: 401, location: "" } }, 0);
await expectCase("PLANT /health names another commit: refused", { health: { status: 200, body: JSON.stringify({ sha: "376eecb3bc27c6d744de35453cfad7a08bdc1d5f" }) } }, 1);
await expectCase("PLANT /health says unknown: refused", { health: { status: 200, body: JSON.stringify({ sha: "unknown" }) } }, 1);
await expectCase("PLANT /health is a 500: refused", { health: { status: 500, body: "" } }, 1);
await expectCase("PLANT the OAuth metadata names another issuer: refused", { metadata: { status: 200, body: JSON.stringify({ issuer: "https://elsewhere.test" }) } }, 1);
await expectCase("PLANT the OAuth metadata is a 500: refused", { metadata: { status: 500, body: "x" } }, 1);
await expectCase("PLANT /mcp answers without a token: refused", { mcp: { status: 200, body: "{}" } }, 1);
await expectCase("PLANT the AI door serves an unknown path: refused", { unknown: { status: 200, body: "<html>" } }, 1);
await expectCase("PLANT the browser host serves Carrel with no sign-in: refused", { browser: { status: 200, location: "" } }, 1);
await expectCase("PLANT the browser host redirects somewhere other than Access: refused", { browser: { status: 302, location: "https://evil.test/login" } }, 1);
await expectCase("no EXPECT_SHA: could not run, not a refusal", {}, 3, { EXPECT_SHA: "" });

mcp.server.close();
browser.server.close();
// Nothing listening: every check goes unanswered, which is exit 3, never a refusal. Slow (retries), so last.
await expectCase("nothing answers: could not run (exit 3)", {}, 3, { CARREL_MCP_ORIGIN: "http://127.0.0.1:9", CARREL_ORIGIN: "http://127.0.0.1:9" });

if (failures.length) {
  console.error(`check:verify-live: ${failures.length} failed.\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("check:verify-live: every case behaved.");
