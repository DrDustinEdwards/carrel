// The MCP tools over books: reading and checking a book's files, AI drafts and flags beside Dustin's,
// and a book an AI made itself (book-project.server.ts), which the AI writes, links to a Google Doc and
// deletes. They call books.server.ts and book-project.server.ts as the book pages do, and hold no role
// logic (tools.ts, at its head).

import { AiRefusal, listAiDrafts } from "~/lib/ai.server";
import {
  createBook,
  deleteAiBook,
  syncAiBookDoc,
  writeAiBookFile,
} from "~/lib/book-project.server";
import {
  bookVoice,
  checkDraft,
  indexedFile,
  listFiles,
  listFindings,
  saveBookAiDraft,
} from "~/lib/books.server";
import { isBookPath } from "~/lib/novels/layout";

import {
  ADD_HERE,
  ANY,
  book,
  BOOK,
  BOOK_PATH,
  CHANGE_GOOGLE,
  DOC,
  flag,
  FLAGGED,
  ID,
  LIST,
  MAX,
  READ,
  RULE,
  SET_HERE,
  shape,
  str,
  TEXT,
  YES,
  type Tool,
} from "./kit";

/** A Git write of the AI's own book: past Carrel, and Git keeps every version, so not destructive. */
const WRITE_GIT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const OWN_BOOK = {
  type: "string",
  description: "The slug of a book an AI made with carrel_create_book, from carrel_list_projects.",
};

export const BOOK_TOOLS: Tool[] = [
  {
    name: "carrel_list_book_files",
    title: "List a book's files",
    scope: "read",
    description: `A book's chapters, scenes, bible and outline files from Carrel's index of the writing repository, with each scene's header and open flags. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: BOOK },
      required: ["project"],
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: shape({ files: LIST }),
    outside: true,
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const [files, open] = await Promise.all([
        listFiles(ctx.env.DB, b),
        listFindings(ctx.env.DB, b, { status: "open" }),
      ]);
      return {
        files: files.map((f) => ({
          path: f.path,
          kind: f.kind,
          words: f.words,
          header: f.meta.kind === "scene" ? f.meta.header : undefined,
          openFlags: open.filter((o) => o.path === f.path).length,
        })),
      };
    },
  },
  {
    name: "carrel_read_book_file",
    title: "Read a book file",
    scope: "read",
    description: `A scene, bible entry or outline file as the index last had it from Git, with its version, its flags, the AI drafts saved beside it, and excerpts of Dustin's own writing (his shared/voice/ passages and this book's finished scenes, among them a long sentence of his and a short one). Before drafting a scene, read the excerpts and write from them; then run carrel_check_book_text and fix only the spans its voice findings name. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: BOOK, path: BOOK_PATH },
      required: ["project", "path"],
      additionalProperties: false,
    },
    annotations: READ,
    outputSchema: shape(
      { path: TEXT, source: TEXT, flags: LIST, aiDrafts: LIST },
      { version: ANY, voice: ANY },
    ),
    outside: true,
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const path = str(args, "path", { max: MAX.path });
      const [file, flags, aiDrafts] = await Promise.all([
        indexedFile(ctx.env.DB, b, path),
        listFindings(ctx.env.DB, b, { path }),
        listAiDrafts(ctx.env.DB, b, ctx.session.viewer, path),
      ]);
      if (!file)
        throw new AiRefusal(
          `There is no ${path} in this book's index. List the files with carrel_list_book_files, or ask Dustin to refresh the book from Git.`,
        );
      return {
        path,
        source: file.source,
        version: file.sha,
        flags,
        aiDrafts,
        voice: await bookVoice(ctx.env.DB, b, path),
      };
    },
  },
  {
    name: "carrel_check_book_text",
    title: "Run the checks on text",
    scope: "read",
    description: `Runs the checks on save (header, continuity, timeline, world rules, and the voice scan against Dustin's own excerpts) on the given text for a book file, without saving or recording anything. The checks flag; Dustin decides. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: BOOK,
        path: BOOK_PATH,
        source: { type: "string", description: "The whole file, header included." },
      },
      required: ["project", "path", "source"],
      additionalProperties: false,
    },
    // Runs the checks on the text given, and saves or records nothing.
    annotations: READ,
    outputSchema: shape({ findings: LIST }),
    outside: false,
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      return {
        findings: await checkDraft(
          ctx.env.DB,
          b,
          str(args, "path", { max: MAX.path }),
          str(args, "source", { max: MAX.source }),
        ),
      };
    },
  },
  {
    name: "carrel_save_book_draft",
    title: "Save an AI draft of a book file",
    scope: "write",
    description: `Saves your version of a book file as a new AI draft beside Dustin's own. It never replaces his draft and is never committed to Git; he reads it in Carrel's editor and decides. ${RULE} Save one only when he asked for it.`,
    inputSchema: {
      type: "object",
      properties: {
        project: BOOK,
        path: BOOK_PATH,
        source: { type: "string", description: "The whole file, header included." },
        note: {
          type: "string",
          description: "One line for Dustin on what this draft changes and why.",
        },
      },
      required: ["project", "path", "source"],
      additionalProperties: false,
    },
    annotations: ADD_HERE,
    outputSchema: shape({ saved: YES, aiDraftId: ID, where: TEXT }, { basedOnVersion: ANY }),
    outside: false,
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const saved = await saveBookAiDraft(
        ctx.env.DB,
        b,
        ctx.session,
        str(args, "path", { max: MAX.path }),
        {
          source: str(args, "source", { max: MAX.source }),
          note: str(args, "note", { optional: true, max: MAX.note }),
        },
      );
      return {
        saved: true,
        aiDraftId: saved.id,
        basedOnVersion: saved.baseVersion,
        where: "Beside Dustin's draft in the book file's editor, under AI drafts.",
      };
    },
  },
  {
    name: "carrel_add_book_finding",
    title: "Flag a problem in a book file",
    scope: "write",
    description: `Flags a problem in a book file for Dustin: a continuity slip, a timeline error, a sentence that says something other than it means. A flag is a question, never a decision; quote the words. It holds export until Dustin fixes the text or dismisses it. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: BOOK,
        path: BOOK_PATH,
        message: { type: "string", description: "What the problem is, in a sentence or two." },
        excerpt: { type: "string", description: "The words the flag is about, quoted exactly." },
      },
      required: ["project", "path", "message"],
      additionalProperties: false,
    },
    annotations: SET_HERE,
    outputSchema: FLAGGED,
    outside: false,
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const path = str(args, "path", { max: MAX.path });
      if (!isBookPath(path)) throw new AiRefusal(`${path} is not a file in the novels layout.`);
      return flag(ctx, args, b, path);
    },
  },
  {
    name: "carrel_create_book",
    title: "Create a book",
    scope: "write",
    description: `Makes a new book in Carrel, in its own folder of the writing repository, when Dustin asks for one. The book is the AI's own: write its files with carrel_write_book_file, link one with a Google Doc with carrel_sync_book_doc, and delete it with carrel_delete_book. Nothing is in Git until the first file is written. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The book's name, up to 120 characters." },
        folder: {
          type: "string",
          description:
            "Its folder in the writing repository and its slug: lower-case letters, digits and single hyphens, such as scratch.",
        },
      },
      required: ["name", "folder"],
      additionalProperties: false,
    },
    annotations: ADD_HERE,
    outputSchema: shape({ project: TEXT }),
    outside: false,
    run: async (args, ctx) => {
      const made = await createBook(ctx.env.DB, ctx.session.viewer, {
        name: str(args, "name", { max: 120 }),
        folder: str(args, "folder", { max: 80 }).trim(),
        madeBy: ctx.session.client,
      });
      if (!made.ok) throw new AiRefusal(made.error);
      return { project: made.slug };
    },
  },
  {
    name: "carrel_write_book_file",
    title: "Write a file of an AI's book",
    scope: "write",
    description: `Commits a file of a book an AI made to Git, credited to you, through the file's room as Desk's Save does; a new path makes a new file. Leave out source to save the working copy as it stands, such as a Doc just brought in. A book made in Desk refuses: its prose is Dustin's, so save a draft beside his with carrel_save_book_draft. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: OWN_BOOK,
        path: BOOK_PATH,
        source: { type: "string", description: "The whole file, header included." },
      },
      required: ["project", "path"],
      additionalProperties: false,
    },
    annotations: WRITE_GIT,
    outputSchema: shape(
      { saved: YES },
      { version: TEXT, commit: TEXT, findings: LIST, message: TEXT },
    ),
    outside: false,
    run: async (args, ctx) => {
      const source = str(args, "source", { optional: true, max: MAX.source });
      const written = await writeAiBookFile(
        ctx.env,
        ctx.session,
        str(args, "project"),
        str(args, "path", { max: MAX.path }),
        args.source === undefined ? undefined : source,
      );
      if (!written.ok) return { saved: false, message: written.message };
      return {
        saved: true,
        version: written.version,
        commit: written.commit,
        findings: written.findings,
      };
    },
  },
  {
    name: "carrel_sync_book_doc",
    title: "Link a file of an AI's book with a Google Doc",
    scope: "write",
    description: `For a book an AI made, as the book file page's Google Doc panel does. direction bring_in makes the Doc (doc, from carrel_list_docs) the file's working copy, its suggestions and comments included, replacing the working copy, and saves nothing to Git; save it with carrel_write_book_file. direction send lays the file's changes since then into the Doc as suggestions labeled with your name, and its new comment threads as comments. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: OWN_BOOK,
        path: BOOK_PATH,
        direction: { type: "string", enum: ["bring_in", "send"] },
        doc: { ...DOC, description: "The Doc's id, from carrel_list_docs; for bring_in." },
      },
      required: ["project", "path", "direction"],
      additionalProperties: false,
    },
    annotations: CHANGE_GOOGLE,
    outputSchema: shape({}, { title: TEXT, suggestions: ANY, threads: ANY, dropped: ANY }),
    outside: false,
    run: async (args, ctx) => {
      const direction = str(args, "direction");
      if (direction !== "bring_in" && direction !== "send")
        throw new AiRefusal("direction is bring_in or send.");
      return syncAiBookDoc(
        ctx.env,
        ctx.session,
        str(args, "project"),
        str(args, "path", { max: MAX.path }),
        direction === "send"
          ? { direction }
          : { direction, doc: str(args, "doc", { max: MAX.path }) },
        ctx.deps.fetcher,
      );
    },
  },
  {
    name: "carrel_delete_book",
    title: "Delete an AI's book",
    scope: "write",
    description: `Deletes a book an AI made, when Dustin asks: its whole folder in Git in one commit (Git keeps the history) and everything Carrel keeps for it, as Desk's Delete book does. A book made in Desk refuses. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: OWN_BOOK },
      required: ["project"],
      additionalProperties: false,
    },
    annotations: { ...WRITE_GIT, destructiveHint: true },
    outputSchema: shape({ deleted: YES }),
    outside: false,
    run: async (args, ctx) => {
      const done = await deleteAiBook(ctx.env, ctx.session, str(args, "project"));
      if (!done.ok) throw new AiRefusal(done.error);
      return { deleted: true };
    },
  },
];
