// StrykerJS 9.6.1 (10.0.0 has a Babel 8 parser bug). Installed per run with --no-save.
// Run one chunk: CHUNK=3 npx stryker run docs/research/mutation/stryker.config.mjs
import { readdirSync, statSync } from "node:fs";

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = [...walk("app"), ...walk("workers")]
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !f.endsWith("routes.ts"))
  .sort();

export const CHUNKS = Number(process.env.CHUNKS ?? 6);
const i = Number(process.env.CHUNK ?? 0);
const mine = files.filter((_, n) => n % CHUNKS === i % CHUNKS);

export default {
  testRunner: "vitest",
  vitest: { configFile: "docs/research/mutation/vitest.stryker.config.ts" },
  coverageAnalysis: "perTest",
  disableBail: true,
  ignoreStatic: true,
  concurrency: 4,
  timeoutMS: 30000,
  mutate: mine,
  incremental: true,
  incrementalFile: `docs/research/mutation/chunks/chunk-${i}.incremental.json`,
  reporters: ["json", "clear-text"],
  jsonReporter: { fileName: `docs/research/mutation/chunks/chunk-${i}.json` },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  checkers: [],
  ignorePatterns: ["docs/research/mutation/chunks", ".wrangler", "build", ".react-router"],
};
