// The page's side of a file's room (workers/doc-room.ts): the shared copy as a Yjs document kept in
// step over one WebSocket, the people in the room and the comments, as the room says them.
//
// The editor is made only once the copy has arrived, so it never starts from an empty document and
// writes that into the room. A change the room refuses (someone who suggests, typing plainly) leaves
// this copy different from everyone else's, so the hook starts again from the room's, and says why.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YProvider from "y-partyserver/provider";
import * as Y from "yjs";

import { patchMarkdown, readMeta, roomMarkdown, type Patched } from "~/lib/editor/collab";
import type { ClientMessage, RoomComment, RoomPerson, ServerMessage } from "~/lib/editor/room-protocol";

export type RoomStatus = "connecting" | "connected" | "offline";

export type Room = {
  doc: Y.Doc;
  provider: YProvider;
  /** The copy has arrived from the room: the editor may be made. */
  synced: boolean;
  status: RoomStatus;
  /** The Markdown the shared copy stands for, suggestions left out: what a save writes. */
  source: string;
  /** The shared copy differs from what was last saved or loaded. */
  unsaved: boolean;
  people: RoomPerson[];
  comments: RoomComment[];
  /** The last thing the room said that the page should say: a refusal, a replacement, an error. */
  notice: string | null;
  /** Counts each fresh start, so the editor is made again over the new copy. */
  generation: number;
  send: (message: Exclude<ClientMessage, { t: "flush" }>) => void;
  /** Resolves once the room has every change made here so far, before a save reads it. */
  flush: () => Promise<void>;
  /** Markdown typed in the Markdown view, or a front matter field, into the shared copy. */
  setSource: (markdown: string) => Patched;
};

type Live = { doc: Y.Doc; provider: YProvider };

export function useRoom(path: string, initial: string, initiallyUnsaved: boolean): Room {
  const [generation, setGeneration] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [synced, setSynced] = useState(false);
  const [status, setStatus] = useState<RoomStatus>("connecting");
  const [source, setSourceState] = useState(initial);
  const [unsaved, setUnsaved] = useState(initiallyUnsaved);
  const [people, setPeople] = useState<RoomPerson[]>([]);
  const [comments, setComments] = useState<RoomComment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const flushes = useRef({ n: 0, waiting: new Map<number, () => void>() });

  useEffect(() => {
    const doc = new Y.Doc();
    const provider = new YProvider(window.location.host, path, doc, {
      prefix: path,
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
      // Another tab of the same person is another connection, so the room knows of both.
      disableBc: true,
    });
    setLive({ doc, provider });
    setSynced(false);
    let frame = 0;
    const take = () => {
      const md = roomMarkdown(doc);
      setSourceState(md);
      setUnsaved(md !== readMeta(doc).saved);
    };
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(take);
    };
    doc.on("update", read);
    const onSync = (done: boolean) => {
      if (!done) return;
      setSynced(true);
      take();
    };
    const onStatus = ({ status: s }: { status: string }) => setStatus(s === "connected" ? "connected" : s === "connecting" ? "connecting" : "offline");
    const onMessage = (raw: string) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (message.t === "people") setPeople(message.people);
      else if (message.t === "comments") setComments(message.comments);
      else if (message.t === "flushed") {
        const done = flushes.current.waiting.get(message.n);
        flushes.current.waiting.delete(message.n);
        done?.();
      } else if (message.t === "replaced") setNotice(`${message.by} replaced the text for everyone.`);
      else if (message.t === "error") setNotice(message.message);
      else if (message.t === "refused") {
        setNotice(`That change was not taken: ${message.reason}`);
        setGeneration((g) => g + 1);
      }
    };
    provider.on("sync", onSync);
    provider.on("status", onStatus);
    provider.on("custom-message", onMessage);
    return () => {
      cancelAnimationFrame(frame);
      for (const done of flushes.current.waiting.values()) done();
      flushes.current.waiting.clear();
      provider.destroy();
      doc.destroy();
    };
  }, [path, generation]);

  const send = useCallback((message: Exclude<ClientMessage, { t: "flush" }>) => live?.provider.sendMessage(JSON.stringify(message)), [live]);
  const flush = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (!live?.provider.wsconnected) return resolve();
        const n = ++flushes.current.n;
        flushes.current.waiting.set(n, resolve);
        live.provider.sendMessage(JSON.stringify({ t: "flush", n }));
        // A room that does not answer does not hold the save: the save reads what the room has.
        window.setTimeout(() => {
          if (flushes.current.waiting.delete(n)) resolve();
        }, 3000);
      }),
    [live],
  );
  const setSource = useCallback((markdown: string): Patched => (live ? patchMarkdown(live.doc, markdown) : { ok: true, changed: false }), [live]);

  return useMemo(
    () =>
      live
        ? { doc: live.doc, provider: live.provider, synced, status, source, unsaved, people, comments, notice, generation, send, flush, setSource }
        : // Before the page is in the browser: the text the server read, and nothing live yet.
          ({ synced: false, status: "connecting", source, unsaved, people, comments, notice, generation, send, flush, setSource } as unknown as Room),
    [live, synced, status, source, unsaved, people, comments, notice, generation, send, flush, setSource],
  );
}

/** A person's color in the room, the same on every screen: one of eight, set in app.css by `data-who`. */
export const personSlot = (id: number) => Math.abs(id) % 8;
