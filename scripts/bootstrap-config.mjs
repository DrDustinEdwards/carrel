// Copies wrangler.jsonc.example to wrangler.jsonc once and never overwrites, so a real config
// carrying the live database id survives any number of reinstalls.

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
