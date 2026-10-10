// A book file's history (job_b4555715afcf): every version Carrel saved, every move that renamed it,
// and every commit made to it outside Carrel, newest first. Carrel's own records come first (the
// authorship rows and book_moves, no GitHub call); Git adds what Carrel did not do, path by path back
// through the file's old names, since GitHub's history of a path stops where it was renamed. Any
// version's text is read from Git at its commit. Read-only, and a Reader may read all of it.

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { authorship, people } from "~/db/schema";
import { formerPaths, movesOf } from "~/lib/binder.server";
import type { BookProject } from "~/lib/books.server";
import type { NovelsRepo } from "~/lib/novels/repo.server";
import { can } from "~/lib/roles";

export type BookVersion = {
  /** The commit that made this version. */
  version: string;
  /** The file's path in the book when this version was made. */
  path: string;
  at: string;
  author: string;
  message: string;
  kind: "carrel" | "move" | "outside";
};

/** How many of the file's former paths are asked of Git, and how many commits for each. */
const PATHS_ASKED = 5;
const COMMITS_PER_PATH = 30;

export async function bookVersions(db: D1Database, repo: NovelsRepo | null, project: BookProject, path: string): Promise<{ versions: BookVersion[]; gitError: string | null }> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  const paths = await formerPaths(db, project.id, path);
  const d = drizzle(db);
  const saves = await d
    .select({ commit: authorship.commitSha, path: authorship.path, at: authorship.createdAt, name: people.name, email: people.email, client: authorship.client, added: authorship.wordsAdded, removed: authorship.wordsRemoved })
    .from(authorship)
    .innerJoin(people, eq(people.id, authorship.personId))
    .where(and(eq(authorship.projectId, project.id), inArray(authorship.path, paths)))
    .all();
  const moves = await movesOf(db, project.id, paths);
  const movers = moves.length
    ? new Map((await d.select({ id: people.id, name: people.name, email: people.email }).from(people).where(inArray(people.id, [...new Set(moves.map((m) => m.personId))])).all()).map((p) => [p.id, p.name || p.email]))
    : new Map<number, string>();

  const byCommit = new Map<string, BookVersion>();
  for (const s of saves) {
    const who = s.name || s.email;
    byCommit.set(s.commit, {
      version: s.commit,
      path: s.path,
      at: s.at,
      author: s.client ? `${s.client} (AI, for ${who})` : who,
      message: `Saved in Carrel: ${s.added} word${s.added === 1 ? "" : "s"} added, ${s.removed} removed`,
      kind: "carrel",
    });
  }
  for (const m of moves) {
    if (!byCommit.has(m.commit)) byCommit.set(m.commit, { version: m.commit, path: m.to, at: m.at, author: movers.get(m.personId) ?? "", message: `Moved from ${m.from}`, kind: "move" });
  }

  let gitError: string | null = null;
  if (repo) {
    try {
      for (const p of paths.slice(0, PATHS_ASKED)) {
        for (const c of await repo.history(`${project.book}/${p}`, COMMITS_PER_PATH)) {
          if (!byCommit.has(c.sha)) byCommit.set(c.sha, { version: c.sha, path: p, at: c.at, author: c.author, message: c.message.split("\n")[0] || "No message", kind: "outside" });
        }
      }
    } catch (error) {
      gitError = `Git did not answer (${error instanceof Error ? error.message : String(error)}), so only the versions Carrel recorded are listed.`;
    }
  }
  const versions = [...byCommit.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { versions, gitError };
}

/** A version's text, read from Git at its commit; null when Git does not hold the file there. */
export async function readVersion(repo: NovelsRepo, project: BookProject, version: BookVersion): Promise<string | null> {
  if (!can(project.role, "read")) throw new Response("Forbidden", { status: 403 });
  return (await repo.readAt(`${project.book}/${version.path}`, version.version))?.source ?? null;
}
