// A person in a file's room, for the tests: a real Yjs client on a real WebSocket into the room's
// Durable Object, as the browser's provider is, so a test types the way a person does.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { getServerByName } from "partyserver";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { patchMarkdown, roomName } from "~/lib/editor/collab";
import { ROOM_VIEWER_HEADER, type RoomViewer, type ServerMessage } from "~/lib/editor/room-protocol";

import { testEnv } from "./env";

/** One person in the room: a Yjs document kept in step over a WebSocket, as the browser's provider does. */
export async function join(projectId: number, itemId: string, viewer: RoomViewer) {
  const room = await getServerByName(testEnv.DOC_ROOM, roomName(projectId, itemId));
  const response = await room.fetch(new Request(`https://carrel.test/collab/p/x/${itemId}`, { headers: { Upgrade: "websocket", [ROOM_VIEWER_HEADER]: JSON.stringify(viewer) } }));
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


/** Types `markdown` into an open file's room as `viewer` (an editor), and waits until the room has it. */
export async function typeIn(projectId: number, itemId: string, viewer: RoomViewer, markdown: string): Promise<void> {
  const person = await join(projectId, itemId, viewer);
  patchMarkdown(person.doc, markdown);
  await person.flush();
  person.close();
}
