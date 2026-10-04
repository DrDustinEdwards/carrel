// Proves the install step cannot wait on input. A stub stands in for wrangler and blocks until its
// stdin ends, as wrangler does when it asks a question. The install is started with an open stdin
// that nobody writes to, like a terminal nobody is watching; it must still exit.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stub = join(mkdtempSync(join(tmpdir(), "carrel-postinstall-")), "wrangler.js");
writeFileSync(stub, 'process.stdin.on("end", () => process.exit(0));\nprocess.stdin.resume();\n');

const child = spawn(process.execPath, [join(root, "scripts", "bootstrap-config.mjs")], {
  cwd: root,
  env: { ...process.env, WRANGLER_ENTRY: stub },
  stdio: ["pipe", "inherit", "inherit"],
});
const timer = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("check:postinstall: the install step is still running after 10 seconds. It is waiting on stdin, which a hidden wrangler prompt would do.");
  process.exit(1);
}, 10_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    console.error(`check:postinstall: the install step exited with ${code}.`);
    process.exit(1);
  }
  console.log("check:postinstall: the install step finished without waiting on input.");
  process.exit(0);
});
