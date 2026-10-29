// Live co-editing (ruling point 3, build step 10): several people in one file through its room
// (workers/doc-room.ts). Each person here is a real Yjs client on a real WebSocket into the room, as a
// browser is. What is checked is what would cost work if it broke: the shared copy saves byte for
// byte, one person's change reaches the other, a save writes the room's text with everyone credited,
// a coauthor who suggests cannot change the text itself, and comments go to everyone.

import { EditorState } from "@tiptap/pm/state";
import { enableSuggestChanges } from "@handlewithcare/prosemirror-suggest-changes";
import { initProseMirrorDoc, prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { getServerByName } from "partyserver";
import { beforeEach, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { FRAGMENT, loadMarkdown, roomMarkdown, roomName, roomSchema } from "~/lib/editor/collab";
import { ROOM_VIEWER_HEADER, type RoomViewer, type ServerMessage } from "~/lib/editor/room-protocol";
import { listSuggestions, settle, suggestingDispatch, suggestionPlugins } from "~/lib/editor/suggest";
import { openRoom, saveRoom } from "~/lib/rooms.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { viewerFor } from "./site";

const corpus = import.meta.glob("./fixtures/markdown/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

let projectId: number;
let ids: { owner: number; editor: number; reader: number };
let n = 0;
const item = () => `post-${Date.now()}-${n++}`;

beforeEach(async () => {
  await resetDb();
  ids = { owner: await addPerson("owner@test.invalid", { owner: true }), editor: await addPerson("editor@test.invalid"), reader: await addPerson("reader@test.invalid") };
  projectId = await addProject("de-info", "dustinedwards");
  await share(projectId, ids.editor, "editor");
  await share(projectId, ids.reader, "reader");
});

const project = (role: "owner" | "editor" | "reader") => ({ id: projectId, role });

/** One person in the room: a Yjs document kept in step over a WebSocket, as the browser's provider does. */
async function join(itemId: string, viewer: RoomViewer) {
  const room = await getServerByName(testEnv.DOC_ROOM, roomName(projectId, itemId));
  const response = await room.fetch(new Request(`https://carrel.test/collab/p/de-info/${itemId}`, { headers: { Upgrade: "websocket", [ROOM_VIEWER_HEADER]: JSON.stringify(viewer) } }));
  const ws = response.webSocket!;
  ws.accept();
  const doc = new Y.Doc();
  const said: ServerMessage[] = [];
  let synced!: () => void;
  const ready = new Promise<void>((resolve) => (synced = resolve));
  // Binary frames come as Blobs here; reading them in turn keeps them in the order they came.
  let inbox = Promise.resolve();
  ws.addEventListener("message", (event) => {
    inbox = inbox.then(() => receive(event.data as string | ArrayBuffer | Blob));
  });
  const receive = async (data: string | ArrayBuffer | Blob) => {
    if (typeof data === "string") {
      if (data.startsWith("__YPS:")) said.push(JSON.parse(data.slice(6)) as ServerMessage);
      return;
    }
    const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== 0) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    const kind = syncProtocol.readSyncMessage(decoder, reply, doc, "room");
    if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
    if (kind === syncProtocol.messageYjsSyncStep2) synced();
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "room") return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  });
  const hello = encoding.createEncoder();
  encoding.writeVarUint(hello, 0);
  syncProtocol.writeSyncStep1(hello, doc);
  ws.send(encoding.toUint8Array(hello));
  await ready;
  /** Waits until the room has handled everything sent so far. */
  let flushes = 0;
  const flush = async () => {
    const want = ++flushes;
    ws.send(`__YPS:${JSON.stringify({ t: "flush", n: want })}`);
    for (let i = 0; i < 100 && !said.some((m) => m.t === "flushed" && m.n === want); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const send = (message: object) => ws.send(`__YPS:${JSON.stringify(message)}`);
  return { doc, said, flush, send, close: () => ws.close() };
}

const as = (id: number, name: string, role: RoomViewer["role"], access: RoomViewer["access"]): RoomViewer => ({ id, name, role, access });

/** An edit made the way an editor makes it: a ProseMirror change written into the shared fragment. */
function edit(doc: Y.Doc, change: (state: EditorState) => EditorState) {
  const fragment = doc.getXmlFragment(FRAGMENT);
  const { doc: pm } = initProseMirrorDoc(fragment, roomSchema());
  const next = change(EditorState.create({ doc: pm, plugins: suggestionPlugins() }));
  // One transaction, one update, as the editor's binding sends it.
  doc.transact(() => prosemirrorToYXmlFragment(next.doc, fragment));
}

const typeAtEnd = (text: string) => (state: EditorState) => state.apply(state.tr.insertText(text, state.doc.child(0).nodeSize - 1));

describe("the shared copy", () => {
  for (const [name, source] of Object.entries(corpus)) {
    it(`PLANT: gives back ${name.replace("./fixtures/markdown/", "")} byte for byte after a trip through Yjs, for a site and for a book`, () => {
      for (const dialect of ["site", "plain"] as const) {
        const room = new Y.Doc();
        loadMarkdown(room, { markdown: source, version: "v1", dialect });
        const copy = new Y.Doc();
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(room));
        expect(roomMarkdown(copy)).toBe(source);
      }
    });
  }
});

describe("a room", () => {
  it("carries one person's change to the other, and a save writes the room's text with both credited", async () => {
    const itemId = item();
    const owner = await viewerFor("owner@test.invalid");
    const opened = await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "First line.\n\nSecond line.\n", version: "v1" } });
    expect(opened).toMatchObject({ source: "First line.\n\nSecond line.\n", version: "v1", unsaved: false, behind: false });

    const a = await join(itemId, as(ids.owner, "owner", "owner", "edit"));
    const b = await join(itemId, as(ids.editor, "editor", "editor", "edit"));
    edit(a.doc, typeAtEnd(" More."));
    await a.flush();
    edit(b.doc, (s) => s.apply(s.tr.insertText("Now ", s.doc.child(0).nodeSize + 1)));
    await b.flush();
    await a.flush();
    // Both see both changes, and the untouched bytes of the file are untouched.
    expect(roomMarkdown(a.doc)).toBe("First line. More.\n\nNow Second line.\n");
    expect(roomMarkdown(b.doc)).toBe(roomMarkdown(a.doc));

    const sent: { source: string; version: string | null }[] = [];
    const saved = await saveRoom(testEnv, project("owner"), owner, itemId, async (source, expectedVersion) => {
      sent.push({ source, version: expectedVersion });
      return { ok: true as const, version: "v2", changeId: "change-1" };
    });
    expect(saved.ok).toBe(true);
    expect(sent).toEqual([{ source: "First line. More.\n\nNow Second line.\n", version: "v1" }]);
    const credited = await testEnv.DB.prepare("SELECT person_id FROM change_contributors WHERE change_id = 'change-1' ORDER BY person_id").all<{ person_id: number }>();
    expect(credited.results.map((r) => r.person_id)).toEqual([ids.owner, ids.editor].sort((x, y) => x - y));

    // The room now starts from the saved version; nothing reads as unsaved, and the backup copy has it.
    const again = await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "First line. More.\n\nNow Second line.\n", version: "v2" } });
    expect(again).toMatchObject({ version: "v2", unsaved: false, behind: false });
    const mirror = await testEnv.DB.prepare("SELECT source, base_version FROM rooms WHERE item_id = ?").bind(itemId).first();
    expect(mirror).toEqual({ source: "First line. More.\n\nNow Second line.\n", base_version: "v2" });
    a.close();
    b.close();
  });

  it("follows the site's newer version when nothing is unsaved, and says it is behind when something is", async () => {
    const itemId = item();
    const owner = await viewerFor("owner@test.invalid");
    await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "One.\n", version: "v1" } });
    const followed = await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "One, from the AI door.\n", version: "v2" } });
    expect(followed).toMatchObject({ source: "One, from the AI door.\n", version: "v2", behind: false });

    const a = await join(itemId, as(ids.owner, "owner", "owner", "edit"));
    edit(a.doc, typeAtEnd(" Mine."));
    await a.flush();
    const behind = await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "Three.\n", version: "v3" } });
    expect(behind).toMatchObject({ source: "One, from the AI door. Mine.\n", version: "v2", unsaved: true, behind: true });
    a.close();
  });

  it("starts from the opener's own earlier draft, which then lives in the room", async () => {
    const itemId = item();
    const owner = await viewerFor("owner@test.invalid");
    await testEnv.DB.prepare("INSERT INTO drafts (project_id, item_id, person_id, source, base_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, itemId, ids.owner, "My draft.\n", "v1", "2026-10-29T00:00:00Z")
      .run();
    const opened = await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "Site.\n", version: "v1" } });
    expect(opened).toMatchObject({ source: "My draft.\n", unsaved: true });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE item_id = ?").bind(itemId).first("n")).toBe(0);
  });
});

describe("a coauthor who suggests", () => {
  it("PLANT: cannot change the text itself, and their suggestion stays out of the save until accepted", async () => {
    const itemId = item();
    const owner = await viewerFor("owner@test.invalid");
    await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "The cat sat.\n", version: "v1" } });
    const coauthor = await join(itemId, as(ids.reader, "reader", "reader", "suggest"));
    const owners = await join(itemId, as(ids.owner, "owner", "owner", "edit"));

    // A plain edit is refused: the room keeps its text and tells the editor to load again.
    edit(coauthor.doc, typeAtEnd(" Plainly."));
    await coauthor.flush();
    expect(coauthor.said.some((m) => m.t === "refused")).toBe(true);
    await owners.flush();
    expect(roomMarkdown(owners.doc)).toBe("The cat sat.\n");

    // A suggestion goes through, marked as theirs, and a save leaves it out.
    const theirs = await join(itemId, as(ids.reader, "reader", "reader", "suggest"));
    const suggest = suggestingDispatch({ by: String(ids.reader), clientId: theirs.doc.clientID, round: () => null });
    edit(theirs.doc, (start) => {
      let on = start;
      enableSuggestChanges(on, (tr) => (on = on.apply(tr)));
      return on.apply(suggest(on, on.tr.insertText(" On the mat.", on.doc.child(0).nodeSize - 1)));
    });
    await theirs.flush();
    await owners.flush();
    expect(theirs.said.some((m) => m.t === "refused")).toBe(false);
    expect(roomMarkdown(owners.doc)).toBe("The cat sat.\n");
    const { doc: pm } = initProseMirrorDoc(owners.doc.getXmlFragment(FRAGMENT), roomSchema());
    expect(listSuggestions(pm).map((s) => ({ by: s.by, inserted: s.inserted }))).toEqual([{ by: String(ids.reader), inserted: " On the mat." }]);
    for (const c of [coauthor, theirs, owners]) c.close();
  });

  it("keeps each person's changes their own when one types against another's", () => {
    const schema = roomSchema();
    let state = EditorState.create({ doc: schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] }), plugins: suggestionPlugins() });
    enableSuggestChanges(state, (tr) => (state = state.apply(tr)));
    const reader = suggestingDispatch({ by: "3", clientId: 1, round: () => "r1" });
    const editor = suggestingDispatch({ by: "2", clientId: 2, round: () => null });
    state = state.apply(reader(state, state.tr.insertText(" there", 6)));
    state = state.apply(editor(state, state.tr.insertText(" friend", 12)));
    expect(listSuggestions(state.doc).map((s) => [s.by, s.inserted, s.round])).toEqual([
      ["3", " there", "r1"],
      ["2", " friend", null],
    ]);
    expect(settle(schema, state.doc.toJSON())).toEqual(schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] }).toJSON());
  });
});

describe("comments", () => {
  it("reach everyone in the room, and only the writer or someone who edits resolves a thread", async () => {
    const itemId = item();
    const owner = await viewerFor("owner@test.invalid");
    await openRoom(testEnv, project("owner"), owner, itemId, { dialect: "site", current: { source: "Text.\n", version: "v1" } });
    const coauthor = await join(itemId, as(ids.reader, "reader", "reader", "suggest"));
    const editor = await join(itemId, as(ids.editor, "editor", "editor", "edit"));
    editor.send({ t: "comment", body: "Is this right?", anchor: null, quote: "Text" });
    await editor.flush();
    await new Promise((r) => setTimeout(r, 50));
    const latest = () => [...coauthor.said].reverse().find((m) => m.t === "comments") as Extract<ServerMessage, { t: "comments" }> | undefined;
    expect(latest()?.comments.map((c) => [c.name, c.body, c.quote])).toEqual([["editor", "Is this right?", "Text"]]);

    const thread = latest()!.comments[0]!.id;
    coauthor.send({ t: "comment-resolve", id: thread, resolved: true });
    await coauthor.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(coauthor.said.some((m) => m.t === "error")).toBe(true);
    editor.send({ t: "comment-resolve", id: thread, resolved: true });
    await editor.flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(latest()?.comments[0]?.resolvedAt).not.toBeNull();
    coauthor.close();
    editor.close();
  });
});
