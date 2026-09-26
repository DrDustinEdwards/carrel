// Creates the one Owner row, so the Owner's email never sits in this public repository.
//
//   npm run seed:owner -- you@example.com "Your Name" --remote
//
// Without --remote it writes the local development database. The SQL goes through a temporary
// file, not --command: on Windows, spawnSync with a shell joins argv unquoted, and a SQL string
// with spaces becomes a program name (recorded in the site's rulings, 2026-09-04).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const [email, name = ""] = args.filter((a) => a !== "--remote");

if (!email || !/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) {
  console.error('usage: npm run seed:owner -- <email> ["Name"] [--remote]');
  process.exit(1);
}

/** @param {string} s */
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const sql =
  `INSERT INTO people (email, name, is_owner) VALUES (${quote(email)}, ${quote(name)}, 1)\n` +
  `ON CONFLICT (email) DO UPDATE SET is_owner = 1, disabled_at = NULL;\n`;

const dir = mkdtempSync(join(tmpdir(), "carrel-seed-"));
const file = join(dir, "seed-owner.sql");
writeFileSync(file, sql);
try {
  const command = `npx wrangler d1 execute DB ${remote ? "--remote" : "--local"} --file "${file}"`;
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
