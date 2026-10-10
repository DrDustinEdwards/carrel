// Reordering a book from the binder or the corkboard (job_b4555715afcf). The new order becomes
// renames of the numbered files, all in ONE commit with the version of each file Carrel indexed, so a
// move never splits across commits and never overwrites a change made elsewhere. After the commit,
// Carrel's own records that name a path follow the file: the index, the flags, the AI drafts beside
// it and the untyped-word count. The authorship record keeps the paths it was written with; a move is
// recorded in book_moves, which a file's history follows back.

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { bookFiles, bookMoves, drafts } from "~/db/schema";
import { listFiles, recheck, type BookProject } from "~/lib/books.server";
import { GitConflict, type NovelsRepo } from "~/lib/novels/repo.server";
import type { Viewer } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { planRenames, type ChapterOrder, type Rename } from "~/lib/writing/binder";

export type ReorderResult =
  | { ok: true; renames: Rename[]; commit: string | null }
  | { ok: false; reason: "stale" | "draft" | "conflict" | "failed"; message: string };

/** The tables that name a book file by its path, and the column that holds it. */
const PATH_COLUMNS = [
  ["book_files", "path"],
  ["findings", "path"],
  ["ai_drafts", "item_id"],
  ["untyped_words", "path"],
] as const;

export async function reorderBook(db: D1Database, repo: NovelsRepo, project: BookProject, viewer: Viewer, desired: ChapterOrder[]): Promise<ReorderResult> {
  if (!can(project.role, "edit")) throw new Response("Forbidden", { status: 403 });
  const files = await listFiles(db, project);
  const plan = planRenames(
    files.map((f) => f.path),
    desired,
  );
  if (!plan.ok) return { ok: false, reason: "stale", message: plan.error };
  if (plan.renames.length === 0) return { ok: true, renames: [], commit: null };

  // A working draft is tied to its path and to the version it started from: moving the file under it
  // would strand the draft, so the move waits until it is saved or discarded.
  const froms = plan.renames.map((r) => r.from);
  const held = await drizzle(db)
    .select({ path: drafts.itemId })
    .from(drafts)
    .where(and(eq(drafts.projectId, project.id), inArray(drafts.itemId, froms)))
    .all();
  if (held.length > 0) {
    const paths = [...new Set(held.map((h) => h.path))].sort();
    return {
      ok: false,
      reason: "draft",
      message: `${paths.join(", ")} ${paths.length === 1 ? "has" : "have"} a working draft in Carrel. Save it to Git or discard it, then move again.`,
    };
  }

  const sha = new Map(files.map((f) => [f.path, f.sha]));
  const changeId = crypto.randomUUID();
  let commit: string;
  try {
    ({ commit } = await repo.commitMany({
      renames: plan.renames.map((r) => ({ from: `${project.book}/${r.from}`, to: `${project.book}/${r.to}`, sha: sha.get(r.from)! })),
      message: `Reorder ${project.book}: ${plan.renames.length} file${plan.renames.length === 1 ? "" : "s"} renumbered\n\nCarrel-Change: ${changeId}`,
      author: { name: viewer.name || viewer.email, email: viewer.email },
    }));
  } catch (error) {
    if (error instanceof GitConflict) {
      return { ok: false, reason: "conflict", message: "The book changed in Git since Carrel last read it, so nothing was moved. Refresh the book from Git, then move again." };
    }
    console.error(JSON.stringify({ book: "reorder-failed", error: String(error) }));
    return { ok: false, reason: "failed", message: "Git did not accept the move, so nothing was moved." };
  }

  // Two steps through a placeholder, so a file moving onto a path another file is leaving never
  // meets it in the table.
  const temp = (i: number) => `\u0000moving/${changeId}/${i}`;
  const statements: D1PreparedStatement[] = [];
  for (const [table, column] of PATH_COLUMNS) {
    plan.renames.forEach((r, i) => statements.push(db.prepare(`UPDATE ${table} SET ${column} = ? WHERE project_id = ? AND ${column} = ?`).bind(temp(i), project.id, r.from)));
    plan.renames.forEach((r, i) => statements.push(db.prepare(`UPDATE ${table} SET ${column} = ? WHERE project_id = ? AND ${column} = ?`).bind(r.to, project.id, temp(i))));
  }
  statements.push(
    ...plan.renames.map((r) =>
      db
        .prepare("INSERT INTO book_moves (project_id, change_id, from_path, to_path, commit_sha, person_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(project.id, changeId, r.from, r.to, commit, viewer.id),
    ),
  );
  await db.batch(statements);

  // The reading order changed, so the timeline check reads every scene again.
  await recheck(db, project.id, "all");
  return { ok: true, renames: plan.renames, commit };
}

/** Every path this file has had, newest first, following the moves back from `path`. */
export async function formerPaths(db: D1Database, projectId: number, path: string): Promise<string[]> {
  const rows = await drizzle(db)
    .select({ from: bookMoves.fromPath, to: bookMoves.toPath, id: bookMoves.id })
    .from(bookMoves)
    .where(eq(bookMoves.projectId, projectId))
    .all();
  const paths = [path];
  // Newest move first; a path is followed back through each move that landed on it before.
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  let current = path;
  let before = Infinity;
  for (;;) {
    const move = sorted.find((m) => m.to === current && m.id < before);
    if (!move || paths.includes(move.from) || paths.length > 50) break;
    paths.push(move.from);
    current = move.from;
    before = move.id;
  }
  return paths;
}

/** The moves of this file, for its history: when it was renamed, by whom, from where, in which commit. */
export async function movesOf(db: D1Database, projectId: number, paths: string[]) {
  if (paths.length === 0) return [];
  return drizzle(db)
    .select({ from: bookMoves.fromPath, to: bookMoves.toPath, commit: bookMoves.commitSha, personId: bookMoves.personId, at: bookMoves.createdAt })
    .from(bookMoves)
    .where(and(eq(bookMoves.projectId, projectId), inArray(bookMoves.toPath, paths)))
    .all();
}

/** The index rows the corkboard needs for one chapter. */
export async function chapterSources(db: D1Database, projectId: number, paths: string[]) {
  if (paths.length === 0) return new Map<string, string>();
  const rows = await drizzle(db)
    .select({ path: bookFiles.path, source: bookFiles.source })
    .from(bookFiles)
    .where(and(eq(bookFiles.projectId, projectId), inArray(bookFiles.path, paths)))
    .all();
  return new Map(rows.map((r) => [r.path, r.source]));
}
