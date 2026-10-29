// The room for one file: a Durable Object on Cloudflare's y-partyserver (ruling point 3, build step
// 10), holding the shared working copy every editor open on the file is connected to, the people in
// it, and the comment threads on it.
//
// Nobody reaches it but the browser door (workers/app.ts, behind Access), which has already checked
// the person's role on the project and says who they are in one header it sets itself. So each
// connection knows its person and what they may do:
// - "edit" (an Editor, an Author, the Owner): any change.
// - "suggest" (a Reader: a coauthor who comments and suggests): a change is taken only when it changes
//   nothing but suggestions, and touches nobody else's (`suggestOnly`). Anything else is refused and
//   their editor is told to load the room again.
// - Everyone in the room may comment; resolving takes edit, or being the comment's writer.
//
// The working copy is kept in the object's own SQLite storage after every change (debounced), so it
// outlives the people in it, hibernation and deploys, and mirrored as Markdown into D1's `rooms`
// table, which the nightly backup carries. Git and the sites stay the store: nothing here is a save.
// A save is the editor route's: it reads the room's Markdown, sends it through site-api's version
// check (or Git's), and tells the room what it wrote (`saved`), with who had a hand in it.

import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as decoding from "lib0/decoding";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";

import { comments, rooms } from "~/db/schema";
import { listComments } from "~/lib/comments.server";
import { isSeeded, loadMarkdown, markSaved, parseRoomName, readMeta, roomJson, roomMarkdown, roomSchema, type RoomMeta } from "~/lib/editor/collab";
import type { Dialect } from "~/lib/editor/markdown.mjs";
import { ROOM_VIEWER_HEADER, type ClientMessage, type RoomViewer, type ServerMessage } from "~/lib/editor/room-protocol";
import { settle, suggestionCounts } from "~/lib/editor/suggest";
import { can } from "~/lib/roles";

const MAX_BODY = 10_000;
const MAX_QUOTE = 500;
const MAX_ANCHOR = 2_000;
const SYNC = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function viewerOf(conn: Connection): RoomViewer | null {
  const state = conn.state as { viewer?: RoomViewer } | null;
  return state?.viewer ?? null;
}

const bytesOf = (message: WSMessage): Uint8Array | null =>
  typeof message === "string" ? null : message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);

/**
 * Whether `update` changes only suggestions, and only the suggester's own: with every suggestion
 * rejected the document reads the same before and after, and nobody else has more suggested.
 */
function suggestOnly(doc: Y.Doc, update: Uint8Array, by: number): boolean {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
  const schema = roomSchema();
  const before = roomJson(probe);
  Y.applyUpdate(probe, update);
  const after = roomJson(probe);
  // The rest of the room's state (the version, the prints) is never a suggester's to change.
  if (JSON.stringify(probe.getMap("carrel").toJSON()) !== JSON.stringify(doc.getMap("carrel").toJSON())) return false;
  if (JSON.stringify(settle(schema, before)) !== JSON.stringify(settle(schema, after))) return false;
  const was = suggestionCounts(schema, before);
  for (const [person, n] of suggestionCounts(schema, after)) if (person !== String(by) && n > (was.get(person) ?? 0)) return false;
  return true;
}

export class DocRoom extends YServer<Env> {
  static options = { hibernate: true };
  // A second after typing stops, and at least every five while it goes on.
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000, timeout: 5000 };

  #where(): { projectId: number; itemId: string } {
    const where = parseRoomName(this.name);
    if (!where) throw new Error(`not a room name: ${this.name}`);
    return where;
  }

  #store() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_state (key TEXT PRIMARY KEY, value BLOB)");
  }

  #get(key: string): unknown {
    this.#store();
    const row = this.ctx.storage.sql.exec<{ value: ArrayBuffer | string }>("SELECT value FROM room_state WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  #put(key: string, value: ArrayBuffer | string) {
    this.#store();
    this.ctx.storage.sql.exec("INSERT INTO room_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** Who changed the document since the last save, by person id, with when they last did. */
  #contributors(): Record<string, string> {
    const raw = this.#get("contributors");
    return typeof raw === "string" ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  async onLoad() {
    const state = this.#get("doc");
    if (state instanceof ArrayBuffer) Y.applyUpdate(this.document, new Uint8Array(state));
  }

  async onStart() {
    await super.onStart();
    // A change by a person is theirs in the authorship record of the next save.
    this.document.on("update", (_update: Uint8Array, origin: unknown) => {
      const viewer = origin && typeof origin === "object" && "state" in origin ? viewerOf(origin as Connection) : null;
      if (!viewer) return;
      const who = this.#contributors();
      who[String(viewer.id)] = new Date().toISOString();
      this.#put("contributors", JSON.stringify(who));
    });
    // Presence is the server's word: a name on a cursor is the person the door let in.
    this.document.awareness.on("update", ({ added, removed }: { added: number[]; removed: number[] }) => {
      if (added.length || removed.length) queueMicrotask(() => this.#sendPeople());
    });
  }

  async onSave() {
    if (isSeeded(this.document)) await this.#persist();
  }

  /** The Markdown and the version into D1, so the nightly backup holds every room. */
  async #mirror() {
    const { projectId, itemId } = this.#where();
    const meta = readMeta(this.document);
    const source = roomMarkdown(this.document);
    const now = new Date().toISOString();
    await drizzle(this.env.DB)
      .insert(rooms)
      .values({ projectId, itemId, source, baseVersion: meta.version, savedSource: meta.saved, updatedAt: now })
      .onConflictDoUpdate({ target: [rooms.projectId, rooms.itemId], set: { source, baseVersion: meta.version, savedSource: meta.saved, updatedAt: now } });
  }

  async #persist() {
    this.#put("doc", Y.encodeStateAsUpdate(this.document).slice().buffer);
    await this.#mirror();
  }

  // ---- the browser door's calls (RPC), each from a route that has checked the person's role

  /** Where the room stands. `seeded` false: nobody has opened the file since live editing began. */
  async status(): Promise<{ seeded: boolean; meta: RoomMeta; markdown: string; people: number }> {
    await this.__unsafe_ensureInitialized();
    const seeded = isSeeded(this.document);
    return { seeded, meta: readMeta(this.document), markdown: seeded ? roomMarkdown(this.document) : "", people: [...this.getConnections()].length };
  }

  /** The first load: the file's text as the site or Git has it (or the opener's own earlier draft). Once only. */
  async seed(input: { markdown: string; version: string | null; dialect: Dialect; saved?: string }): Promise<boolean> {
    await this.__unsafe_ensureInitialized();
    if (isSeeded(this.document)) return false;
    loadMarkdown(this.document, input);
    await this.#persist();
    return true;
  }

  /**
   * Replaces the whole text for everyone (Discard, the site's newer version, an AI draft taken, a
   * draft from before the room, an import). `unsaved`: the new text is not what the site or Git holds. `expectedVersion`, when given, must still be the room's, so two people asking for
   * the site's newer version cannot load it twice over someone's new work.
   */
  async replace(input: { markdown: string; version: string | null; by: string; expectedVersion?: string | null; unsaved?: boolean }): Promise<boolean> {
    await this.__unsafe_ensureInitialized();
    // A room nobody has opened has no dialect to read the text in: it starts from `seed`.
    if (!isSeeded(this.document)) return false;
    if (input.expectedVersion !== undefined && readMeta(this.document).version !== input.expectedVersion) return false;
    // Text nobody has saved yet (an AI draft taken, an import) leaves the last saved text as it was.
    loadMarkdown(this.document, { markdown: input.markdown, version: input.version, ...(input.unsaved ? { saved: readMeta(this.document).saved } : {}) });
    await this.#persist();
    this.#broadcast({ t: "replaced", by: input.by });
    return true;
  }

  /** What a save writes now, the version it must be checked against, and who has changed it since the last save. */
  async snapshot(): Promise<{ seeded: boolean; markdown: string; version: string | null; at: string; contributors: number[] }> {
    await this.__unsafe_ensureInitialized();
    return { seeded: isSeeded(this.document), markdown: roomMarkdown(this.document), version: readMeta(this.document).version, at: new Date().toISOString(), contributors: Object.keys(this.#contributors()).map(Number) };
  }

  /**
   * After a save: the version it made and the text it wrote. Gives back who had a hand in that text
   * (everyone who changed it before the snapshot was taken) and forgets them until they change it again.
   */
  async saved(input: { version: string | null; markdown: string; snapshotAt: string }): Promise<number[]> {
    await this.__unsafe_ensureInitialized();
    markSaved(this.document, input.version, input.markdown);
    const who = this.#contributors();
    const credited: number[] = [];
    for (const [id, at] of Object.entries(who)) {
      if (at > input.snapshotAt) continue;
      credited.push(Number(id));
      delete who[id];
    }
    this.#put("contributors", JSON.stringify(who));
    await this.#persist();
    return credited;
  }

  /**
   * After a write that sent no text (unpublish, unschedule): the new version, taken only when the site
   * still holds the text the room last saved, so unsaved work stays checked against what it started from.
   */
  async rebase(input: { version: string; source: string }): Promise<boolean> {
    await this.__unsafe_ensureInitialized();
    const meta = readMeta(this.document);
    if (!isSeeded(this.document) || meta.saved !== input.source) return false;
    markSaved(this.document, input.version, meta.saved);
    await this.#persist();
    return true;
  }

  // ---- connections

  onConnect(conn: Connection, ctx: ConnectionContext) {
    const raw = ctx.request.headers.get(ROOM_VIEWER_HEADER);
    const viewer = raw ? (JSON.parse(raw) as RoomViewer) : null;
    if (!viewer || !isSeeded(this.document)) {
      // Only the door connects, and only to a room its page has loaded.
      conn.close(4403, viewer ? "This file is not open yet. Reload the page." : "Forbidden");
      return;
    }
    conn.setState((prev: unknown) => ({ ...(prev as object | null), viewer }));
    void super.onConnect(conn, ctx);
    this.#sendPeople();
    void this.#sendComments(conn);
  }

  onClose(conn: Connection, code: number, reason: string, wasClean: boolean) {
    void super.onClose(conn, code, reason, wasClean);
    this.#sendPeople();
  }

  isReadOnly(conn: Connection): boolean {
    return viewerOf(conn)?.access !== "edit";
  }

  onMessage(conn: Connection, message: WSMessage) {
    const viewer = viewerOf(conn);
    const bytes = bytesOf(message);
    if (viewer?.access === "suggest" && bytes) {
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) === SYNC) {
        const step = decoding.readVarUint(decoder);
        if (step === SYNC_STEP2 || step === SYNC_UPDATE) {
          const update = decoding.readVarUint8Array(decoder);
          if (suggestOnly(this.document, update, viewer.id)) Y.applyUpdate(this.document, update, conn);
          else this.#send(conn, { t: "refused", reason: "Only suggestions can be made here. Your editor loads the room again." });
          return;
        }
      }
    }
    this.handleMessage(conn, message);
  }

  onCustomMessage(conn: Connection, raw: string) {
    const viewer = viewerOf(conn);
    if (!viewer) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    // Messages on one socket arrive in order, so the answer comes after every change sent before it.
    if (message.t === "flush") return this.#send(conn, { t: "flushed", n: Number(message.n) || 0 });
    void this.#comment(conn, viewer, message).catch((error: unknown) => {
      console.error(JSON.stringify({ room: "comment-failed", error: String(error) }));
      this.#send(conn, { t: "error", message: "The comment was not saved. Try again." });
    });
  }

  #send(conn: Connection, message: ServerMessage) {
    this.sendCustomMessage(conn, JSON.stringify(message));
  }

  #broadcast(message: ServerMessage) {
    this.broadcastCustomMessage(JSON.stringify(message));
  }

  #sendPeople() {
    const list = [...this.getConnections()].flatMap((c) => {
      const v = viewerOf(c);
      const clients = ((c.state as { __ypsAwarenessIds?: number[] } | null)?.__ypsAwarenessIds ?? []).slice();
      return v ? [{ conn: c.id, id: v.id, name: v.name, access: v.access, clients }] : [];
    });
    this.#broadcast({ t: "people", people: list });
  }

  // ---- comments

  async #sendComments(conn?: Connection) {
    const { projectId, itemId } = this.#where();
    const list = await listComments(this.env.DB, projectId, itemId);
    if (conn) this.#send(conn, { t: "comments", comments: list });
    else this.#broadcast({ t: "comments", comments: list });
  }

  async #comment(conn: Connection, viewer: RoomViewer, message: Exclude<ClientMessage, { t: "flush" }>) {
    const { projectId, itemId } = this.#where();
    const db = drizzle(this.env.DB);
    const now = new Date().toISOString();
    const refuse = (text: string) => this.#send(conn, { t: "error", message: text });
    if (!can(viewer.role, "comment")) return refuse("Your role here does not include comments.");
    const own = async (id: string) =>
      db
        .select({ personId: comments.personId, parentId: comments.parentId })
        .from(comments)
        .where(and(eq(comments.id, id), eq(comments.projectId, projectId), eq(comments.itemId, itemId), isNull(comments.deletedAt)))
        .get();
    switch (message.t) {
      case "comment": {
        const body = String(message.body ?? "").trim();
        if (!body || body.length > MAX_BODY) return refuse(`A comment is 1 to ${MAX_BODY.toLocaleString("en")} characters.`);
        const parentId = message.parentId ? String(message.parentId) : null;
        // A reply hangs off the thread's first comment, and takes its place in the text from it.
        const parent = parentId ? await own(parentId) : null;
        if (parentId && (!parent || parent.parentId)) return refuse("That thread is gone.");
        const anchor = parentId ? null : message.anchor ? String(message.anchor).slice(0, MAX_ANCHOR) : null;
        await db.insert(comments).values({
          id: crypto.randomUUID(),
          projectId,
          itemId,
          parentId,
          personId: viewer.id,
          body,
          anchor,
          quote: parentId ? "" : String(message.quote ?? "").slice(0, MAX_QUOTE),
          createdAt: now,
        });
        break;
      }
      case "comment-edit": {
        const row = await own(String(message.id));
        const body = String(message.body ?? "").trim();
        if (!row || row.personId !== viewer.id) return refuse("Only the person who wrote a comment can change it.");
        if (!body || body.length > MAX_BODY) return refuse(`A comment is 1 to ${MAX_BODY.toLocaleString("en")} characters.`);
        await db.update(comments).set({ body, editedAt: now }).where(eq(comments.id, String(message.id)));
        break;
      }
      case "comment-resolve": {
        const row = await own(String(message.id));
        if (!row || row.parentId) return refuse("That thread is gone.");
        if (row.personId !== viewer.id && !can(viewer.role, "edit")) return refuse("Resolving a thread takes edit rights, or having started it.");
        await db
          .update(comments)
          .set(message.resolved ? { resolvedAt: now, resolvedBy: viewer.id } : { resolvedAt: null, resolvedBy: null })
          .where(eq(comments.id, String(message.id)));
        break;
      }
      case "comment-delete": {
        const row = await own(String(message.id));
        if (!row || (row.personId !== viewer.id && viewer.role !== "owner")) return refuse("Only the person who wrote a comment, or the Owner, can delete it.");
        // A thread's first comment takes its replies with it.
        await db.update(comments).set({ deletedAt: now }).where(eq(comments.id, String(message.id)));
        if (!row.parentId) await db.update(comments).set({ deletedAt: now }).where(and(eq(comments.parentId, String(message.id)), isNull(comments.deletedAt)));
        break;
      }
      default:
        return;
    }
    await this.#sendComments();
  }
}
