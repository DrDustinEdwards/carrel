# Carrel test audit and mutation baseline (job_8e69e02626ac)

Measured 2026-10-10 at commit 8b6c066 (main) plus this PR's docs. Linux container, 4 cores, Node 22.22
(the repo asks for 24.14.1 or newer; nothing here depended on it). Method follows Foxhound's
`docs/research/baseline.md`. Nothing in the app or the tests changed and no test was deleted.

## Commands and results

| What | Command | Result |
|------|---------|--------|
| Unit tests | `npx vitest run` | 35 files, 455 tests, all passed; 55 s wall (14.2 s of it inside test files, the rest is workerd and D1 start-up) |
| Contract check | `node scripts/check-deploy.mjs` | passes, 1 s |
| MCP roles gate | `npm run check:mcp-roles` | passes, under 1 s |
| Conformance gate | `npm run check:conformance` | passes, 20 s |
| Plants gate | `npm run check:plants` | 18 of 18 planted failures caught, 296 s (needs `wrangler.jsonc` rendered from the example, as CI does) |
| a11y gate | `npm run check:a11y` | 308 scans, no WCAG 2.2 A or AA violation, 278 s |
| Source size | `cloc app workers test` | 142 files, 18,895 code lines |

The harness is the app the a11y gate drives, so its cost is inside the 278 s.

## Mutation testing (StrykerJS 9.6.1)

Stryker 9.6.1 was installed with `npm i --no-save` (10.0.0 has a Babel 8 parser bug); `package.json` and the
lockfile are untouched. Setup is in `docs/research/mutation/`: vitest runner, `coverageAnalysis: perTest`,
`disableBail: true`, `ignoreStatic: true`, concurrency 4. Mutated: every `.ts` and `.tsx` file under `app/`
and `workers/` except `.d.ts` and `app/routes.ts`. That is 91 files and 14,042 mutants, of which 1,286 are
static (ignored) and 12,756 count.

The run was 12 chunks (`stryker.config.mjs`, `CHUNK=n CHUNKS=12`), one at a time with incremental mode on.
Each chunk's JSON and incremental file went to the branch `results/carrel-mutation-baseline` (`chunks/`) as
soon as it finished, so a restart would have cost at most one chunk. Chunk times ran from 9 to 40 minutes,
4 h 38 min in all. `docs/research/mutation/report.mjs` merges them.

`test/wrangler-config.test.ts` (2 tests) reads the raw text of config files, which
Stryker's rewriting breaks, so `vitest.stryker.config.ts` leaves it out. It is not in the kill matrix.

### Score

| Status | Mutants |
|--------|---------|
| Killed | 5,828 |
| Timeout (counted as killed) | 7 |
| Survived | 2,152 |
| No coverage | 4,769 |
| Ignored (static) | 1,286 |
| Valid (killed + survived + no coverage) | 12,756 |

- **Mutation score: 45.74%** (5,835 of 12,756).
- Score over covered code: 73.06% (5,835 of 7,987).
- 37.4% of mutants have no covering test. Most of those are route modules and components
  (`app/routes/project.tsx` alone has 257), which the suite exercises through the worker only in part, and
  the a11y gate covers without asserting on code behavior.

### Per-test kill matrix

453 tests, keyed by file and test name; the full matrix (kills, unique kills, covered count, kind, protected
flag per test) is `docs/research/kill-matrix.json`. 23 tests were never listed by any chunk's dry run and
are counted as zero-kill.

| Group | Tests | Of which protected |
|-------|-------|--------------------|
| Unique kills (at least one mutant only this test kills) | 293 | 183 |
| Zero-kill (kills no mutant) | 29 | 9 |
| Covered by others (every kill is also made by another test) | 131 | 109 |
| Unprotected zero-kill candidates | 20 | |
| Unprotected covered-by-others candidates | 22 | |

Protected means the test file or name matches the keep rules in `docs/research/mutation/report.mjs`:
auth, access, session, OAuth, token, key, secret, signing, CSP, gate, plant, publish, role, owner, door,
permission, origin, redirect, sanitise and escape, XSS, injection, traversal, and refusals (401, 403,
forbidden). The match is a name heuristic that errs toward keeping. These are never removal candidates.
Carrel's plants are a script (`scripts/plant-gates.mjs`), not unit tests, so the plants gate itself is
untouched and out of this matrix.

### Removal candidates (nothing removed)

42 unprotected tests in 15 files (20 zero-kill, 22 covered by others):

| Test file | Tests | Zero-kill | Covered by others |
|---|---|---|---|
| test/bloat.test.ts | 14 | 12 | 0 |
| test/import.test.ts | 9 | 6 | 0 |
| test/health.test.ts | 18 | 0 | 4 |
| test/legal.test.ts | 21 | 0 | 4 |
| test/checks.test.ts | 27 | 0 | 3 |
| test/index.test.ts | 8 | 1 | 2 |
| test/mcp.test.ts | 17 | 0 | 2 |
| test/books.test.ts | 19 | 0 | 2 |
| test/kinds.test.ts | 3 | 0 | 1 |
| test/routes.test.ts | 6 | 0 | 1 |
| test/google.test.ts | 26 | 1 | 0 |
| test/editor-ux.test.ts | 4 | 0 | 1 |
| test/media-writes.test.ts | 12 | 0 | 1 |
| test/frontmatter.test.ts | 10 | 0 | 1 |

How to read this before any pruning job uses it:

- Candidates are per test, not joint. Two tests that only cover each other are both flagged, and removing
  both loses kills. A pruning step must re-run Stryker on the affected chunk after each batch.
- A zero-kill test is not worthless. `test/bloat.test.ts` and `test/import.test.ts` exercise `scripts/`
  code Stryker does not mutate; `test/google.test.ts` and `test/index.test.ts` have one each. Check what
  the test protects before cutting.
- The suite is lean: 42 candidates of 453 tests, and most covered-by-others tests are protected. Pruning is worth little here.
- Survived mutants (2,152) and no-coverage mutants (4,769) point the other way: they show behavior no test
  pins. The lowest-scoring security files are `app/lib/access.server.ts` (38.5%), `app/lib/mcp/door.ts`
  (55.1%), `app/lib/mcp/access-login.ts` (56.7%) and `app/lib/mcp/tools.ts` (60.0%). Adding tests there
  is worth more than trimming.

### Per-file score

Lowest first. A file with 0% and all mutants uncovered has no test that reaches it.

| File | Mutants | Killed | Survived | No coverage | Score |
|---|---|---|---|---|---|
| app/components/editor/frontmatter-fields.tsx | 108 | 0 | 0 | 108 | 0.0% |
| app/lib/refresh.server.ts | 18 | 0 | 0 | 18 | 0.0% |
| app/components/editor/typing.ts | 30 | 0 | 0 | 30 | 0.0% |
| app/db/schema.ts | 15 | 0 | 0 | 15 | 0.0% |
| app/lib/google/refresh.server.ts | 31 | 0 | 0 | 31 | 0.0% |
| app/root.tsx | 18 | 0 | 0 | 18 | 0.0% |
| app/entry.server.tsx | 17 | 0 | 0 | 17 | 0.0% |
| app/routes/project.new.tsx | 51 | 0 | 0 | 51 | 0.0% |
| app/components/editor/writing-surface.tsx | 9 | 0 | 0 | 9 | 0.0% |
| app/components/frame.tsx | 138 | 0 | 0 | 138 | 0.0% |
| workers/app.ts | 11 | 0 | 0 | 11 | 0.0% |
| app/components/history/draft-links.tsx | 11 | 0 | 0 | 11 | 0.0% |
| app/components/history/revision-picker.tsx | 21 | 0 | 0 | 21 | 0.0% |
| app/components/media/library-insert.tsx | 124 | 0 | 0 | 124 | 0.0% |
| app/components/media/upload.ts | 16 | 0 | 0 | 16 | 0.0% |
| app/components/page-head.tsx | 8 | 0 | 0 | 8 | 0.0% |
| app/components/project-tabs.tsx | 17 | 0 | 0 | 17 | 0.0% |
| app/routes/frame.tsx | 30 | 0 | 0 | 30 | 0.0% |
| app/routes/mentions.tsx | 250 | 1 | 1 | 248 | 0.4% |
| app/routes/project.tsx | 302 | 16 | 29 | 257 | 5.3% |
| app/routes/manuscripts.tsx | 75 | 7 | 13 | 55 | 9.3% |
| app/routes/social.tsx | 276 | 26 | 19 | 231 | 9.4% |
| app/routes/book.chapter.tsx | 114 | 11 | 18 | 85 | 9.6% |
| app/routes/book.new.tsx | 34 | 4 | 2 | 28 | 11.8% |
| app/routes/editor.tsx | 825 | 110 | 46 | 669 | 13.3% |
| app/routes/media.tsx | 911 | 137 | 61 | 713 | 15.0% |
| app/routes/home.tsx | 35 | 6 | 5 | 24 | 17.1% |
| app/routes/project.flags.tsx | 92 | 16 | 6 | 70 | 17.4% |
| app/routes/ai-draft.tsx | 67 | 12 | 6 | 49 | 17.9% |
| app/routes/people.tsx | 179 | 42 | 11 | 126 | 23.5% |
| app/routes/book.file.tsx | 584 | 140 | 61 | 383 | 24.0% |
| app/routes/legal.tsx | 103 | 28 | 12 | 63 | 27.2% |
| app/routes/book.tsx | 278 | 76 | 56 | 146 | 27.3% |
| app/routes/unpublish.tsx | 65 | 19 | 6 | 40 | 29.2% |
| app/routes/media.bulk.ts | 84 | 28 | 31 | 25 | 33.3% |
| app/routes/ai-draft.preview.ts | 28 | 10 | 5 | 13 | 35.7% |
| app/lib/access.server.ts | 52 | 20 | 26 | 6 | 38.5% |
| app/routes/mentions.api.ts | 51 | 20 | 5 | 26 | 39.2% |
| app/routes/history.tsx | 299 | 122 | 56 | 121 | 40.8% |
| app/lib/novels/voice.ts | 136 | 63 | 71 | 2 | 46.3% |
| app/routes/project.bulk.ts | 56 | 26 | 9 | 21 | 46.4% |
| app/lib/sites.server.ts | 84 | 40 | 11 | 33 | 47.6% |
| app/lib/patch.ts | 4 | 2 | 2 | 0 | 50.0% |
| app/routes/media.api.ts | 65 | 34 | 13 | 18 | 52.3% |
| app/lib/mcp/door.ts | 245 | 135 | 79 | 31 | 55.1% |
| app/lib/mcp/access-login.ts | 104 | 59 | 35 | 10 | 56.7% |
| app/lib/social/lint.ts | 59 | 34 | 20 | 5 | 57.6% |
| app/lib/mcp/tools.ts | 275 | 165 | 60 | 50 | 60.0% |
| app/lib/novels/export.ts | 296 | 179 | 105 | 12 | 60.5% |
| app/lib/media.server.ts | 427 | 261 | 94 | 72 | 61.1% |
| app/lib/social/routine.server.ts | 80 | 49 | 20 | 11 | 61.3% |
| app/lib/mcp/server.ts | 26 | 16 | 10 | 0 | 61.5% |
| app/lib/social/platforms.server.ts | 223 | 138 | 65 | 20 | 61.9% |
| app/lib/google/oauth.server.ts | 209 | 132 | 52 | 25 | 63.2% |
| app/lib/google/drive.server.ts | 230 | 147 | 64 | 19 | 63.9% |
| app/lib/social/queue.server.ts | 443 | 286 | 96 | 61 | 64.6% |
| app/lib/google/service-account.server.ts | 147 | 95 | 43 | 9 | 64.6% |
| app/lib/content.server.ts | 230 | 152 | 41 | 37 | 66.1% |
| app/lib/preview.server.ts | 54 | 36 | 15 | 3 | 66.7% |
| app/lib/context.ts | 3 | 2 | 0 | 1 | 66.7% |
| app/lib/mcp/legacy-era.ts | 3 | 2 | 1 | 0 | 66.7% |
| app/lib/ai.server.ts | 215 | 144 | 58 | 13 | 67.0% |
| app/routes/preview.ts | 31 | 21 | 0 | 10 | 67.7% |
| app/routes/book.export.ts | 47 | 32 | 9 | 6 | 68.1% |
| app/lib/frontmatter.ts | 267 | 183 | 61 | 23 | 68.5% |
| app/lib/agent-keys.server.ts | 55 | 38 | 9 | 8 | 69.1% |
| app/lib/waiting.server.ts | 114 | 79 | 33 | 2 | 69.3% |
| app/lib/novels/layout.ts | 297 | 209 | 61 | 27 | 70.4% |
| app/lib/health.server.ts | 365 | 257 | 61 | 47 | 70.4% |
| app/routes/auth.google.ts | 24 | 17 | 2 | 5 | 70.8% |
| app/lib/mentions.server.ts | 205 | 146 | 35 | 24 | 71.2% |
| app/lib/books.server.ts | 534 | 381 | 129 | 24 | 71.3% |
| app/routes/book.authorship.ts | 7 | 5 | 2 | 0 | 71.4% |
| app/lib/history.server.ts | 47 | 34 | 5 | 8 | 72.3% |
| app/lib/novels/frontmatter.ts | 194 | 141 | 49 | 4 | 72.7% |
| app/lib/bulk.server.ts | 281 | 206 | 30 | 45 | 73.3% |
| app/lib/legal.server.ts | 134 | 99 | 32 | 3 | 73.9% |
| app/lib/google/search-console.server.ts | 66 | 49 | 13 | 4 | 74.2% |
| workers/csp.ts | 36 | 28 | 8 | 0 | 77.8% |
| workers/gate.ts | 45 | 35 | 8 | 2 | 77.8% |
| app/lib/novels/checks.ts | 349 | 275 | 68 | 6 | 78.8% |
| app/lib/novels/repo.server.ts | 219 | 175 | 37 | 7 | 79.9% |
| app/lib/legal.ts | 118 | 97 | 18 | 3 | 82.2% |
| app/lib/index.server.ts | 131 | 108 | 19 | 4 | 82.4% |
| app/lib/people-admin.server.ts | 113 | 94 | 16 | 3 | 83.2% |
| app/lib/projects.server.ts | 13 | 11 | 2 | 0 | 84.6% |
| app/lib/people.server.ts | 42 | 37 | 5 | 0 | 88.1% |
| app/lib/site-markdown.ts | 12 | 11 | 1 | 0 | 91.7% |
| app/lib/roles.ts | 6 | 6 | 0 | 0 | 100.0% |
| app/lib/save-state.ts | 13 | 13 | 0 | 0 | 100.0% |

Nothing was deleted or changed in the app or the tests. The raw chunk reports are on the branch
`results/carrel-mutation-baseline`.
