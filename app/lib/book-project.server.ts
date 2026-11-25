// A book's life as a project: made by the Owner, and deleted by the Owner with its folder in Git. A book can also be
// made by one of the Owner's AI sessions through the MCP door (madeBy names the AI). That book is the AI's own work, so
// an AI writes its files to Git, links them with a Google Doc and deletes it; in a book made in Desk, AI never
// rewrites Dustin's prose and only saves drafts beside his (carrel_save_book_draft).

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { logEvent } from "@dustinedwards/site-runtime/log";

import { normalizeNewlines } from "@drdustinedwards/site-helpers/text";

import { projects } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import { bookRepo, requireBookProject, saveBookFile, type BookProject } from "~/lib/books.server";
import { bringInDoc, sendToDoc } from "~/lib/google/book-docs.server";
import { isBookFolder, isBookPath } from "~/lib/novels/layout";
import { GitConflict, type NovelsRepo } from "~/lib/novels/repo.server";
import type { Viewer } from "~/lib/people.server";
import { openRoom, replaceRoom, saveRoom } from "~/lib/rooms.server";

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

/**
 * A new book: a project whose folder in the writing repository is `folder`. Nothing is written to Git. `madeBy` is
 * the AI that asked for it through the MCP door.
 */
export async function createBook(
  db: D1Database,
  viewer: Viewer,
  input: { name: string; folder: string; madeBy?: string },
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
  await d
    .insert(projects)
    .values({ slug: input.folder, name, book: input.folder, madeBy: input.madeBy ?? null });
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

/** A book an AI made, for the Owner's own sessions; any other book refuses, because its prose is Dustin's. */
async function aiBook(env: Env, session: AiSession, slug: string, path?: string) {
  if (!session.viewer.isOwner) forbid();
  const project = await requireBookProject(env.DB, session.viewer, slug, "edit");
  const row = await drizzle(env.DB)
    .select({ madeBy: projects.madeBy })
    .from(projects)
    .where(eq(projects.id, project.id))
    .get();
  if (!row?.madeBy)
    throw new AiRefusal(
      "This book was made in Desk, so its prose is Dustin's: save a draft beside his file with carrel_save_book_draft. Only a book an AI made with carrel_create_book is written, linked to a Doc or deleted here.",
    );
  if (path !== undefined && !isBookPath(path))
    throw new AiRefusal(`${path} is not a file in the novels layout.`);
  const { repo, detail } = bookRepo(env);
  if (!repo) throw new AiRefusal(detail);
  return { project, repo };
}

/** The file's room, opened as its page opens it: from Git, or empty for a new file. */
async function openFile(
  env: Env,
  session: AiSession,
  project: BookProject,
  repo: NovelsRepo,
  path: string,
) {
  const git = await repo.read(`${project.book}/${path}`);
  const opened = await openRoom(env, project, session.viewer, path, {
    dialect: "plain",
    current: git ? { source: git.source, version: git.sha } : null,
  });
  if (!opened) throw new AiRefusal("The file's room did not open. Try again.");
  return opened;
}

/**
 * Writes a file of an AI's own book to Git through its room, as Desk's Save does: `source` becomes the working copy
 * first, or, left out, the working copy is saved as it stands (a Doc just brought in). Credited to the AI.
 */
export async function writeAiBookFile(
  env: Env,
  session: AiSession,
  slug: string,
  path: string,
  source?: string,
) {
  const { project, repo } = await aiBook(env, session, slug, path);
  const opened = await openFile(env, session, project, repo, path);
  if (source !== undefined)
    await replaceRoom(env, project, session.viewer, path, {
      markdown: normalizeNewlines(source),
      version: opened.version,
      unsaved: true,
    });
  return saveRoom(env, project, session.viewer, path, (text, expectedVersion, others) =>
    saveBookFile(env.DB, repo, project, session.viewer, path, {
      source: text,
      expectedVersion,
      client: session.client,
      shared: others,
    }),
  );
}

/** Brings a Google Doc into a file of an AI's own book as its working copy, or sends the file's changes back to it. */
export async function syncAiBookDoc(
  env: Env,
  session: AiSession,
  slug: string,
  path: string,
  input: { direction: "bring_in"; doc: string } | { direction: "send" },
  fetcher?: typeof fetch,
) {
  const { project, repo } = await aiBook(env, session, slug, path);
  await openFile(env, session, project, repo, path);
  if (input.direction === "send") return sendToDoc(env, project, session, path, fetcher);
  const { text: _text, ...brought } = await bringInDoc(
    env,
    project,
    session.viewer,
    path,
    input.doc,
    fetcher,
  );
  return brought;
}

/** Deletes an AI's own book, its folder in Git and all Carrel keeps for it, as Desk's Delete book does. */
export async function deleteAiBook(env: Env, session: AiSession, slug: string) {
  const { project, repo } = await aiBook(env, session, slug);
  return deleteBook(env.DB, repo, session.viewer, project);
}
