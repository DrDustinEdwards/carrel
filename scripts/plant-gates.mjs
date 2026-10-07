// check:plants. Proves each gate fails. A gate never seen failing has not been verified.
//
// For every gate the MCP rebuild relies on (typecheck, build, tests, check:mcp-roles,
// check:conformance), one or more planted violations: the plant is applied to a file, confirmed to
// have landed, the gate is run and must exit non-zero, and the file is restored byte for byte from a
// snapshot taken before the plant. Snapshots, not git: a checkout would also throw away uncommitted
// work, and would not restore an untracked file.
//
// The test plants each remove one guard the design names (Owner-only publish, publish refused on an
// open flag, reviewers never write, the ID token's nonce, the unknown-person refusal, the per-request
// person check) and run the test files that should notice.
//
// Exit 0: every plant caught. Exit 1: a plant was missed or did not land. Exit 2: a gate was red
// before anything was planted.
//
// Run: npm run check:plants (several minutes: it runs the conformance suite twice)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/** @type {Record<string, [string, string[]]>} */
const GATES = {
  typecheck: [NPM, ["run", "typecheck"]],
  build: [NPM, ["run", "build"]],
  roles: [process.execPath, ["scripts/check-mcp-roles.mjs"]],
  conformance: [process.execPath, ["scripts/check-conformance.mjs"]],
};

const MCP_TESTS = ["test/mcp.test.ts", "test/mcp-followups.test.ts", "test/door.test.ts", "test/agent-keys.test.ts"];

/** Each plant: the gate that must catch it, the file, the exact text replaced, and what replaces it. */
const PLANTS = [
  { gate: "typecheck", file: "app/lib/mcp/server.ts", find: "const SERVER_INFO =", replace: 'const PLANTED: number = "a string";\nconst SERVER_INFO =', label: "a type error in the protocol layer" },
  { gate: "build", file: "app/lib/mcp/door.ts", find: 'import { findAgentViewer, findViewer } from "~/lib/people.server";', replace: 'import { findAgentViewer, findViewer } from "~/lib/people.server";\nimport "./no-such-module";', label: "an import that does not resolve" },
  {
    gate: "tests",
    file: "app/lib/ai.server.ts",
    find: 'if (!session.viewer.isOwner || project.role !== "owner") throw new AiRefusal',
    replace: "if (false) throw new AiRefusal",
    label: "publish no longer Owner-only",
  },
  { gate: "tests", file: "app/lib/ai.server.ts", find: "  if (open.length > 0) {", replace: "  if (false) {", label: "publish no longer refused while a flag is open" },
  {
    gate: "tests",
    file: "app/lib/ai.server.ts",
    find: 'if (session.viewer.isReviewer) throw new AiRefusal("A reviewer flags; it does not write text. Use add_finding.");',
    replace: "",
    label: "a reviewer may write a draft",
  },
  { gate: "tests", file: "app/lib/mcp/access-login.ts", find: 'if (payload.nonce !== input.nonce) return { ok: false, reason: "nonce-mismatch" };', replace: "", label: "the ID token's nonce unchecked" },
  { gate: "tests", file: "app/lib/mcp/door.ts", find: "  if (!viewer) {\n    // Access let them in", replace: "  if (viewer === undefined) {\n    // Access let them in", label: "an unknown person gets a grant" },
  { gate: "tests", file: "app/lib/mcp/door.ts", find: "if (!viewer || viewer.id !== props?.personId) {", replace: "if (!viewer) {", label: "the per-request person check trusts a stale grant" },
  // Named agent keys (job_77fd33040bdd): the key names an agent and grants nothing.
  { gate: "tests", file: "app/lib/agent-keys.server.ts", find: 'if (typeof native === "function") return native.call(crypto.subtle, a, b);', replace: 'if (typeof native === "function") return true;', label: "any presented key matches a configured agent key" },
  { gate: "tests", file: "app/lib/mcp/door.ts", find: "if (agent) return agentHandler(request, env, ctx, agent);", replace: 'if (agent || request.headers.get("Authorization")) return agentHandler(request, env, ctx, agent ?? "grok");', label: "an unknown key or an OAuth token is treated as the grok agent" },
  { gate: "tests", file: "app/lib/mcp/door.ts", find: "if (agent) return agentHandler(request, env, ctx, agent);", replace: 'if (agent) return agentHandler(request, env, ctx, request.headers.get("X-Agent-Name") ?? agent);', label: "the agent's name taken from the request" },
  { gate: "tests", file: "app/lib/mcp/door.ts", find: "{ viewer, client: agentClient(name) }", replace: "{ viewer: { ...viewer, isOwner: true }, client: agentClient(name) }", label: "an agent key acts as the Owner" },
  { gate: "tests", file: "app/lib/people.server.ts", find: "return viewer && !viewer.isOwner ? viewer : null;", replace: "return viewer;", label: "a person row marked Owner may be an agent" },
  { gate: "tests", file: "app/lib/agent-keys.server.ts", find: "/^Bearer[ ]+(\\S+)$/i.exec(authorization.trim())", replace: "/^\\s*(?:Bearer\\s+)?(\\S+)/i.exec(authorization.trim())", label: "a bare key with no Bearer scheme is read as an agent key" },
  { gate: "tests", file: "app/lib/people.server.ts", find: "and(eq(people.email, email.trim()), isNull(people.disabledAt))", replace: "eq(people.email, email.trim())", label: "a disabled person (or agent) is still found" },
  { gate: "roles", file: "app/lib/mcp/tools.ts", find: "    run: async (args, ctx) => {\n      // Refused on the role", replace: "    run: async (args, ctx) => {\n      if (!ctx.session.viewer.isOwner) throw new AiRefusal(\"planted\");\n      // Refused on the role", label: "an Owner check in a tool" },
  {
    gate: "conformance",
    file: "app/lib/mcp/server.ts",
    find: "return createLegacyEraHandler(factory, options)(request, env, ctx);",
    replace: 'return createMcpHandler(factory, { ...options, legacy: "reject" })(request, env, ctx);',
    label: "the legacy shim routed to the modern-only handler",
  },
  { gate: "conformance", file: "app/lib/mcp/door.ts", find: "      clientIdMetadataDocumentEnabled: true,\n", replace: '      clientIdMetadataDocumentEnabled: true,\n      clientRegistrationEndpoint: "/register",\n', label: "a registration endpoint on the CIMD-only door" },
];

/**
 * @param {string} gate
 * @param {string[]} extra
 */
function run(gate, extra) {
  const [cmd, args] = gate === "tests" ? [NPX, ["vitest", "run", ...extra]] : GATES[gate];
  // A shell only for npm and npx, which are .cmd files on Windows. Node itself runs without one: under
  // cmd.exe its path, C:\Program Files\..., splits at the space and exits 1 before any gate runs,
  // which once read here as a caught plant.
  const shell = process.platform === "win32" && (cmd === NPM || cmd === NPX);
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", shell, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// Every gate must be green on the unplanted tree first. A gate that is already red "catches" any
// plant, so its result would mean nothing (measured here: typecheck was red on an unrelated error,
// and its plant read as caught).
for (const gate of new Set(PLANTS.map((p) => p.gate))) {
  const { code, out } = run(gate, MCP_TESTS);
  if (code !== 0) {
    console.log(`  BASELINE RED  ${gate} exits ${code} with nothing planted; fix it first, or no plant result means anything.`);
    console.log(out.slice(-1500));
    process.exit(2);
  }
  console.log(`  BASELINE      ${gate} green`);
}

let caught = 0;
let missed = 0;

for (const plant of PLANTS) {
  const original = readFileSync(`${ROOT}/${plant.file}`, "utf8");
  // Line endings as the file has them, so a plant written with \n lands on a CRLF checkout too.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const find = plant.find.replaceAll("\n", eol);
  if (original.split(find).length !== 2) {
    missed += 1;
    console.log(`  DID NOT LAND  ${plant.gate.padEnd(11)} ${plant.label}: the text to replace is not in ${plant.file} exactly once`);
    continue;
  }
  try {
    writeFileSync(`${ROOT}/${plant.file}`, original.replace(find, plant.replace.replaceAll("\n", eol)));
    if (readFileSync(`${ROOT}/${plant.file}`, "utf8") === original) throw new Error("the plant did not change the file");
    const { code, out } = run(plant.gate, MCP_TESTS);
    if (code !== 0 && code !== null) {
      caught += 1;
      console.log(`  CAUGHT (exit ${code})  ${plant.gate.padEnd(11)} ${plant.label}`);
    } else {
      missed += 1;
      console.log(`  MISSED (exit ${code})  ${plant.gate.padEnd(11)} ${plant.label}   <-- the gate does NOT catch this`);
      console.log(out.slice(-1200));
    }
  } finally {
    writeFileSync(`${ROOT}/${plant.file}`, original);
  }
  if (readFileSync(`${ROOT}/${plant.file}`, "utf8") !== original) {
    console.log(`  RESTORE FAILED for ${plant.file}; stopping so nothing else runs on a planted tree.`);
    process.exit(1);
  }
}

console.log(`\ncheck:plants: ${caught} caught, ${missed} missed or not landed, of ${PLANTS.length}.`);
process.exit(missed ? 1 : 0);
