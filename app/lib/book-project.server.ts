// A book's life as a project: made by the Owner, and deleted by the Owner with its folder in Git.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { logEvent } from "@dustinedwards/site-runtime/log";

import { projects } from "~/db/schema";
import type { BookProject } from "~/lib/books.server";
import { isBookFolder } from "~/lib/novels/layout";
import { GitConflict, type NovelsRepo } from "~/lib/novels/repo.server";
import type { Viewer } from "~/lib/people.server";

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

/** A new book: a project whose folder in the writing repository is `folder`. Nothing is written to Git. */
export async function createBook(
  db: D1Database,
  viewer: Viewer,
  input: { name: string; folder: string },
) {
  if (!viewer.isOwner) forbid();
  const name = input.name.trim();
  if (!name || name.length > 120)
    return { ok: false as const, error: "Give the book a name of up to 120 characters." };
  if (!isBookFolder(input.folder))
    return {
      ok: false as const,
      error:
        "Use lower-case letters, digits and single hyphens for the folder, such as paluxy-portal.",
    };
  const d = drizzle(db);
  const taken = await d
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, input.folder))
    .get();
  if (taken) return { ok: false as const, error: `A project already uses ${input.folder}.` };
  const clash = await d
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.book, input.folder))
    .get();
  if (clash)
    return { ok: false as const, error: `Another book already uses the folder ${input.folder}.` };
  await d.insert(projects).values({ slug: input.folder, name, book: input.folder });
  return { ok: true as const, slug: input.folder };
}

/**
 * Deletes a book: its whole folder in the writing repository in one commit (Git keeps the history, so
 * it can be brought back), then the project and everything Carrel keeps for it. The Owner's alone.
 * Git goes first, so a refusal leaves the book as it was.
 */
export async function deleteBook(
  db: D1Database,
  repo: NovelsRepo,
  viewer: Viewer,
  project: BookProject,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!viewer.isOwner) forbid();
  try {
    const files = await repo.tree(project.book);
    if (files.length > 0)
      await repo.commitMany({
        renames: [],
        removes: files.map((f) => ({ path: `${project.book}/${f.path}`, sha: f.sha })),
        message: `Delete ${project.book}\n\nCarrel-Change: ${crypto.randomUUID()}`,
        author: { name: viewer.name || viewer.email, email: viewer.email },
      });
  } catch (error) {
    if (error instanceof GitConflict)
      return {
        ok: false,
        error: "The book changed in Git a moment ago, so nothing was deleted. Try again.",
      };
    logEvent("book.delete-failed", { error: String(error) }, { level: "error" });
    return { ok: false, error: "Git did not accept the deletion, so nothing was deleted." };
  }
  await drizzle(db).delete(projects).where(eq(projects.id, project.id));
  return { ok: true };
}
