// A book file and a Google Doc, both ways (the Docs plan, slice 8): the Doc comes into the file's room with Google's
// suggestions as Carrel's, each by the person whose name it carries, and its comment threads on the same words; what
// changed in Carrel goes back into the Doc as suggestions, a Google suggestion accepted here is accepted there, and a
// thread started here becomes a comment. All against the fake Google's Docs API and a real room.

import { EditorState } from "@tiptap/pm/state";
import { initProseMirrorDoc, prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FRAGMENT, roomSchema, suggestionPlugins } from "capsomer/behavior/collab-editor";
import { listComments } from "~/lib/comments.server";
import { bringInDoc, editsBetween, sendToDoc } from "~/lib/google/book-docs.server";
import { refreshManuscripts } from "~/lib/google/drive.server";
import { clearSaTokenCache } from "~/lib/google/service-account.server";
import { openRoom, roomDocument } from "~/lib/rooms.server";

import { addBook, addPerson, resetDb, share } from "./env";
import { fakeGoogle, serviceAccountKey } from "./google";
import { join } from "./room";
import { connectedEnv, viewerFor } from "./site";

const FOLDER = "folderRoot1";
const DOC = "docBookAAAA1";
const FILE = "chapters/01-harbor/scene-1.md";

let key: Awaited<ReturnType<typeof serviceAccountKey>>;
beforeAll(async () => {
  key = await serviceAccountKey();
});

let google: ReturnType<typeof fakeGoogle>;
let env: Env;
let ids: { owner: number; editor: number };
let projectId: number;

beforeEach(async () => {
  clearSaTokenCache();
  await resetDb();
  ids = {
    owner: await addPerson("owner@test.invalid", { owner: true }),
    editor: await addPerson("editor@test.invalid"),
  };
  projectId = await addBook("harbor");
  await share(projectId, ids.editor, "editor");
  google = fakeGoogle({
    publicJwk: key.publicJwk,
    files: [
      { id: DOC, name: "Harbor", mimeType: "application/vnd.google-apps.document", parent: FOLDER },
    ],
  });
  const doc = google.addDoc(DOC, {
    title: "Harbor",
    lists: { "kix.l1": {} },
    paragraphs: [
      // "Harbor\n" is 1 to 8; the paragraph after starts at 8, so "rain" is 12 to 16.
      { heading: 1, segs: [{ t: "Harbor" }] },
      {
        segs: [
          { t: "The rain came over " },
          { t: "the old pier", ins: true, id: "suggest.ed1" },
          { t: "." },
        ],
      },
      { bullet: { listId: "kix.l1" }, segs: [{ t: "Nets" }] },
      { bullet: { listId: "kix.l1" }, segs: [{ t: "Ropes", bold: true }] },
    ],
  });
  doc.suggestions.push({ suggestionId: "suggest.ed1", status: "OPEN", by: "editor", posts: [] });
  doc.comments.push({
    commentId: "c.1",
    status: "OPEN",
    quote: "rain",
    by: "editor",
    anchor: [12, 16],
    posts: [{ content: "Rain or sleet?" }, { content: "Rain." }],
  });
  env = {
    ...connectedEnv(),
    GOOGLE_SA_KEY: key.json,
    GOOGLE_MANUSCRIPTS_FOLDER_ID: FOLDER,
  } as Env;
  await refreshManuscripts(env, google.fetch);
});

const where = () => ({ id: projectId, role: "owner" as const });

/** A change made in the room the way the editor makes one, written into the shared fragment. */
async function editRoom(change: (state: EditorState) => EditorState) {
  const person = await join(projectId, FILE, { id: ids.owner, name: "owner", access: "edit" });
  const fragment = person.doc.getXmlFragment(FRAGMENT);
  const { doc } = initProseMirrorDoc(fragment, roomSchema());
  const next = change(EditorState.create({ doc, plugins: suggestionPlugins() }));
  person.doc.transact(() => prosemirrorToYXmlFragment(next.doc, fragment));
  await person.flush();
  person.close();
}

describe("a book file and its Google Doc", () => {
  it("brings the Doc in with its suggestions and threads, and sends Carrel's changes back as suggestions", async () => {
    const owner = await viewerFor("owner@test.invalid");
    await openRoom(env, where(), owner, FILE, {
      dialect: "plain",
      current: { source: "Old text.\n", version: "v1" },
    });

    const brought = await bringInDoc(env, where(), owner, FILE, DOC, google.fetch);
    expect(brought).toMatchObject({ title: "Harbor", suggestions: 1, threads: 1, dropped: 0 });

    // The Doc's shape, and Google's suggestion as the editor's, in its round.
    const room = (await roomDocument(env, where(), FILE))!;
    expect(room.content!.map((b) => b.type)).toEqual(["heading", "paragraph", "bulletList"]);
    const suggested = room.content![1]!.content!.find((n) => n.text === "the old pier")!;
    expect(suggested.marks).toEqual([
      {
        type: "insertion",
        attrs: {
          id: "gdocs:suggest.ed1",
          by: String(ids.editor),
          round: "Google Docs",
          at: "2026-11-01T10:00:00Z",
        },
      },
    ]);
    expect(room.content![2]!.content![1]!.content![0]!.content![0]!.marks).toEqual([
      { type: "bold" },
    ]);

    // The thread, on the same words, the editor's, reply and all.
    const threads = await listComments(env.DB, projectId, FILE);
    expect(threads.map((c) => [c.quote, c.personId, c.body])).toEqual([
      ["rain", ids.editor, "From Google Docs, editor: Rain or sleet?"],
      ["", ids.editor, "From Google Docs, editor: Rain."],
    ]);
    // A second bring-in replaces those threads rather than doubling them.
    await bringInDoc(env, where(), owner, FILE, DOC, google.fetch);
    expect(await listComments(env.DB, projectId, FILE)).toHaveLength(2);

    // In Carrel: the editor's suggestion accepted, words added to the last item, a new thread.
    await editRoom((state) => {
      const tr = state.tr;
      tr.removeMark(0, state.doc.content.size, state.schema.marks.insertion!);
      let end = 0;
      state.doc.descendants((n, pos) => {
        if (n.isTextblock && n.textContent === "Ropes") end = pos + 1 + n.content.size;
        return true;
      });
      tr.insertText(" and hooks", end);
      return state.apply(tr);
    });
    await env.DB.prepare(
      "INSERT INTO comments (id, project_id, item_id, person_id, body, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("k1", projectId, FILE, ids.editor, "Which nets?", "Nets", "2999-01-01T00:00:00Z")
      .run();

    const sent = await sendToDoc(env, where(), owner, FILE, google.fetch);
    expect(sent).toMatchObject({ accepted: 1, rejected: 0, undecided: 0, commented: 1 });
    expect(sent.suggested).toBe(1);
    const doc = google.docApi.get(DOC)!;
    expect(doc.suggestions.find((t) => t.suggestionId === "suggest.ed1")!.status).toBe("ACCEPTED");
    const suggest = doc.batches.filter(
      (b) => (b.writeControl as { writeMode?: string } | undefined)?.writeMode === "SUGGEST",
    );
    expect(JSON.stringify(suggest)).toContain(" and hooks");
    expect(doc.comments.some((c) => c.posts[0]?.content.includes("editor: Which nets?"))).toBe(
      true,
    );
  });
});

describe("the edits a send lays in", () => {
  it("changes the fewest words, adds new paragraphs after the one before, and takes out a paragraph gone", () => {
    const doc = ["The rain came.", "It was cold.", "The end."];
    expect(editsBetween(doc, ["The rain came in.", "It was cold.", "The end."])).toEqual([
      { find: "came.", replace: "came in." },
    ]);
    expect(editsBetween(doc, ["The rain came.", "It was cold.", "New one.", "The end."])).toEqual([
      { insert_after: "cold.", text: "\nNew one." },
    ]);
    expect(editsBetween(doc, ["The rain came.", "The end."])).toEqual([
      { find: "It was cold.", replace: "" },
    ]);
  });
});
