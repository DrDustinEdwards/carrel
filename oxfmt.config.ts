import { defineConfig } from "oxfmt";
import { format } from "@dustinedwards/devkit/oxfmt";

export default defineConfig({
  ...format,
  ignorePatterns: [
    ...(format.ignorePatterns ?? []),
    // D1 migrations apply on deploy and drizzle/manifest.json holds their hashes (devkit-migrations): byte for byte.
    "drizzle/",
    // Written by the mutation report (devkit-mutation-report --json), byte for byte.
    "docs/research/kill-matrix.json",
    // Deploy configs stay as committed.
    "wrangler.jsonc",
  ],
});
