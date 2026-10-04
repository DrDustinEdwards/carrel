// The install step. Copies wrangler.jsonc.example to wrangler.jsonc once and never overwrites, so a
// real config carrying the live database id survives any number of reinstalls. Then generates the
// worker types. Since wrangler 4.135.0, `wrangler types` on a terminal asks whether to update
// Cloudflare skills, and npm hides script output, so the question is invisible and the install
// waits forever. Wrangler has no switch for that prompt, so it runs with stdin detached: it then
// sees a non-interactive session and never asks. Node starts it directly, which works the same
// under cmd.exe and on Linux CI.

import { spawnSync } from "node:child_process";
import { constants, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "wrangler.jsonc");
const src = join(root, "wrangler.jsonc.example");

if (!existsSync(dest)) {
  if (!existsSync(src)) {
    console.error("bootstrap-config: wrangler.jsonc.example is missing, so wrangler.jsonc cannot be created.");
    process.exit(1);
  }
  try {
    copyFileSync(src, dest, constants.COPYFILE_EXCL);
    console.log(
      "bootstrap-config: created wrangler.jsonc from the example. Fill in the D1 database id and ALERT_EMAIL before deploying.",
    );
  } catch (err) {
    if (!(err instanceof Error && /** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST")) throw err;
  }
}

// WRANGLER_ENTRY is only for scripts/check-postinstall.mjs, which stands a stub in for wrangler.
const wrangler = process.env.WRANGLER_ENTRY ?? join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const result = spawnSync(process.execPath, [wrangler, "types", "--strict-vars=false"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
