// Merge the chunk reports into the score, the per-file table and the per-test kill matrix.
// node docs/research/mutation/report.mjs <chunks-dir> <out-dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const [dir = "docs/research/mutation/chunks", out = "docs/research", vitestJson] = process.argv.slice(2);
const KEPT = /auth|access|session|oauth|token|key|secret|signing|csp|gate|plant|publish|role|owner|door|permission|origin|redirect|sanit|escape|xss|inject|traversal|refus|forbid|unauthor|403|401|mcp-roles|conformance/i;

const files = {};
const tests = {}; // "file :: name" -> { kills:Set, unique:number, protected }
for (const f of readdirSync(dir).filter((n) => /^chunk-\d+\.json$/.test(n))) {
  const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const byId = {};
  for (const [tf, v] of Object.entries(r.testFiles)) {
    for (const t of v.tests) {
      const key = `${tf} :: ${t.name}`;
      byId[t.id] = key;
      tests[key] ??= { file: tf, name: t.name, kills: 0, unique: 0, covered: 0 };
    }
  }
  for (const [path, v] of Object.entries(r.files)) {
    const c = (files[path] = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, Ignored: 0, Other: 0 });
    for (const m of v.mutants) {
      c[m.status in c ? m.status : "Other"]++;
      for (const id of m.coveredBy ?? []) if (byId[id]) tests[byId[id]].covered++;
      if (m.status === "Killed" || m.status === "Timeout") {
        const k = [...new Set(m.killedBy ?? [])];
        for (const id of k) if (byId[id]) tests[byId[id]].kills++;
        if (k.length === 1 && byId[k[0]]) tests[byId[k[0]]].unique++;
      }
    }
  }
}

// Tests the dry runs never listed (vitest --reporter=json output, third argument): zero kills.
let unlisted = 0;
if (vitestJson) {
  const base = JSON.parse(readFileSync(vitestJson, "utf8"));
  for (const f of base.testResults) {
    const rel = f.name.slice(f.name.indexOf("/test/") + 1);
    for (const t of f.assertionResults) {
      const key = `${rel} :: ${t.fullName}`;
      if (!tests[key] && !rel.endsWith("wrangler-config.test.ts")) {
        tests[key] = { file: rel, name: t.fullName, kills: 0, unique: 0, covered: 0 };
        unlisted++;
      }
    }
  }
}

const tot = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, Ignored: 0, Other: 0 };
for (const c of Object.values(files)) for (const k in tot) tot[k] += c[k];
const valid = (c) => c.Killed + c.Timeout + c.Survived + c.NoCoverage;
const score = (c) => (valid(c) ? (100 * (c.Killed + c.Timeout)) / valid(c) : 0);
const covered = (c) => c.Killed + c.Timeout + c.Survived;

const matrix = Object.values(tests).map((t) => {
  const prot = KEPT.test(t.file) || KEPT.test(t.name);
  const kind = t.kills === 0 ? "zero-kill" : t.unique === 0 ? "covered-by-others" : "unique-kills";
  return { ...t, protected: prot, kind };
});
writeFileSync(`${out}/kill-matrix.json`, JSON.stringify(matrix, null, 1) + "\n");

const rows = Object.entries(files)
  .map(([p, c]) => ({ p, ...c, score: score(c), n: valid(c) }))
  .sort((a, b) => a.score - b.score);
const md = [];
md.push(`TOTAL ${JSON.stringify(tot)} valid=${valid(tot)} score=${score(tot).toFixed(2)} coveredScore=${((100 * (tot.Killed + tot.Timeout)) / covered(tot)).toFixed(2)} noCovPct=${((100 * tot.NoCoverage) / valid(tot)).toFixed(1)}`);
md.push("| File | Mutants | Killed | Survived | No coverage | Score |", "|---|---|---|---|---|---|");
for (const r of rows) md.push(`| ${r.p} | ${r.n} | ${r.Killed + r.Timeout} | ${r.Survived} | ${r.NoCoverage} | ${r.score.toFixed(1)}% |`);
writeFileSync(`${out}/mutation-files.md`, md.join("\n") + "\n");

const g = (k, p) => matrix.filter((t) => t.kind === k && t.protected === p).length;
const cand = matrix.filter((t) => !t.protected && t.kind !== "unique-kills");
const byFile = {};
for (const t of cand) (byFile[t.file] ??= { z: 0, c: 0 })[t.kind === "zero-kill" ? "z" : "c"]++;
const all = {};
for (const t of matrix) all[t.file] = (all[t.file] ?? 0) + 1;
const cl = Object.entries(byFile).sort((a, b) => b[1].z + b[1].c - (a[1].z + a[1].c));
const o = [`TESTS ${matrix.length} zero(p/u)=${g("zero-kill", true)}/${g("zero-kill", false)} covered(p/u)=${g("covered-by-others", true)}/${g("covered-by-others", false)} unique=${matrix.filter((t) => t.kind === "unique-kills").length}`];
o.push("| Test file | Tests | Zero-kill | Covered by others |", "|---|---|---|---|");
for (const [f, v] of cl) o.push(`| ${f} | ${all[f]} | ${v.z} | ${v.c} |`);
writeFileSync(`${out}/mutation-candidates.md`, o.join("\n") + "\n");
console.log(md[0]);
console.log(o[0], "unlisted", unlisted);
