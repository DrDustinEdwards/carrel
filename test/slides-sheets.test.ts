// The Slides and Sheets side of the Docs tools, against the fake Google's Slides and Sheets
// APIs. Slides has no suggestions: an AI comments, and changes a slide's text only on the Owner's ask. Sheets is
// never written over: cells go on a tab Carrel made. Planted: a slide text change that is not the Owner's ask, a cell
// write or a tab outside Carrel's own, and a comment with an assignee are refused in code before anything is sent.

import { beforeEach, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/d1";

import { docActions, sheetTabs } from "~/db/schema";
import { setDocLock } from "~/lib/google/docs.server";
import { assertAllowed, ServiceAccountRefused } from "~/lib/google/service-account.server";

import { mailbox, testEnv } from "./env";
import { type fakeGoogle } from "./google";
import { connectAs } from "./mcp-client";
import { googleDesk, viewerFor } from "./site";

const FOLDER = "folderRoot1";
const DECK = "deckTestAAA1";
const BOOK = "bookTestAAA1";
const SLIDES = "application/vnd.google-apps.presentation";
const SHEET = "application/vnd.google-apps.spreadsheet";

let google: ReturnType<typeof fakeGoogle>;
let env: Env;
let box: ReturnType<typeof mailbox>;

beforeEach(async () => {
  ({ google, env, box } = await googleDesk(
    FOLDER,
    [
      { id: DECK, name: "Talk", mimeType: SLIDES, parent: FOLDER },
      { id: BOOK, name: "Counts", mimeType: SHEET, parent: FOLDER },
    ],
    (g) => {
      g.addSlides(DECK, {
        title: "Talk",
        slides: [
          {
            id: "s1",
            boxes: [
              { id: "s1t", text: "Aims\n" },
              { id: "s1b", text: "Count the herons.\n" },
            ],
          },
          {
            id: "s2",
            boxes: [{ id: "s2b", text: "Methods: count the herons twice.\n" }],
            notes: "Say it slowly.\n",
          },
        ],
      });
      g.addSheetFile(BOOK, {
        title: "Counts",
        tabs: [
          {
            sheetId: 0,
            title: "Data",
            rows: [
              ["site", "herons"],
              ["A", "4"],
              ["B", "9"],
            ],
          },
        ],
      });
    },
  ));
});

const connect = (email = "owner@test.invalid", client = "Claude") =>
  connectAs(email, client, { env, deps: { fetcher: google.fetch } });

type Answer = {
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
};
const data = (r: Answer) =>
  r.structuredContent as unknown as {
    docs: { kind: string }[];
    text: string;
    comments: { quote: string; status: string }[];
    labeled: boolean;
  } & Record<string, unknown>;

describe("Slides", () => {
  it("lists the kinds, reads the slides with notes and comments, and comments on quoted text, a slide and a reply", async () => {
    const c = await connect();
    const list = data(await c.call("carrel_list_docs", {}));
    expect(list.docs.map((d) => d.kind).sort()).toEqual(["sheet", "slides"]);

    const read = data(await c.call("carrel_read_doc", { doc: DECK }));
    expect(read.text).toContain("## Slide 2 (s2)\nMethods: count the herons twice.");
    expect(read.text).toContain("Notes: Say it slowly.");
    expect(data(await c.call("carrel_read_doc", { doc: DECK, tab: "1" })).text).not.toContain(
      "Methods",
    );

    const quoted = data(
      await c.call("carrel_comment_doc", {
        doc: DECK,
        quote: "twice",
        text: "Why twice?",
        tab: "2",
      }),
    );
    expect(quoted.labeled).toBe(true);
    const thread = google.slideApi.get(DECK)!.comments[0]!;
    expect(thread).toMatchObject({ slide: "s2", at: { box: "s2b", start: 26, end: 31 } });
    expect(thread.posts[0]!.content).toBe("Claude, through Carrel: Why twice?");

    await c.call("carrel_comment_doc", { doc: DECK, tab: "1", text: "Tighten this slide." });
    expect(google.slideApi.get(DECK)!.comments[1]).toMatchObject({ slide: "s1" });
    expect((await c.call("carrel_comment_doc", { doc: DECK, text: "x" })).isError).toBe(true);
    // "herons" is on both slides: a quote must be unique.
    expect(
      (await c.call("carrel_comment_doc", { doc: DECK, quote: "herons", text: "x" })).isError,
    ).toBe(true);

    await c.call("carrel_comment_doc", {
      doc: DECK,
      reply_to: thread.commentId,
      action: "resolve",
    });
    expect(thread.status).toBe("RESOLVED");
    const again = data(await c.call("carrel_read_doc", { doc: DECK }));
    expect(again.comments[0]).toMatchObject({ quote: "twice", status: "RESOLVED" });
    expect(again.comments[1]!.quote).toBe("Slide 1");
  });

  it("has no suggestions: a text change is refused unless the Owner asked for a direct write, which is recorded and emailed", async () => {
    const c = await connect("owner@test.invalid", "Grok Bot");
    const edits = [{ find: "twice", replace: "three times" }];
    const refused = await c.call("carrel_change_doc", { doc: DECK, reason: "r", edits });
    expect(refused.isError).toBe(true);
    expect(google.slideApi.get(DECK)!.batches).toEqual([]);

    const written = data(
      await c.call("carrel_change_doc", {
        doc: DECK,
        mode: "write",
        reason: "Dustin asked",
        edits,
      }),
    );
    expect(written).toMatchObject({ mode: "write", undo: "", emailed: true });
    expect(google.slideApi.get(DECK)!.slides[1]!.boxes[0]!.text).toBe(
      "Methods: count the herons three times.\n",
    );
    expect(box.sent[0]!.text).toContain("before: twice");
    const rows = await drizzle(testEnv.DB).select().from(docActions).all();
    expect(
      rows.map((r) => [r.fileId, r.action, r.beforeText?.includes("count the herons twice")]),
    ).toEqual([[DECK, "write", true]]);
    // Undo is for Docs: Google keeps a presentation's own history.
    expect((await c.call("carrel_undo_doc", { doc: DECK })).isError).toBe(true);
  });

  it("PLANT: suggest only refuses a direct write, and no AI refuses every tool; nothing is sent to Slides", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const c = await connect();
    await setDocLock(testEnv.DB, owner, DECK, "suggest-only");
    expect(
      (
        await c.call("carrel_change_doc", {
          doc: DECK,
          mode: "write",
          reason: "r",
          edits: [{ find: "Aims", replace: "Goals" }],
        })
      ).isError,
    ).toBe(true);
    await setDocLock(testEnv.DB, owner, DECK, "no-ai");
    expect((await c.call("carrel_read_doc", { doc: DECK })).isError).toBe(true);
    expect((await c.call("carrel_comment_doc", { doc: DECK, tab: "1", text: "x" })).isError).toBe(
      true,
    );
    expect(google.requests.filter((r) => r.includes("slides.googleapis.com"))).toEqual([]);
  });
});

describe("Sheets", () => {
  it("reads the tabs' cells and comments, and comments on a cell", async () => {
    const c = await connect();
    const done = data(
      await c.call("carrel_comment_doc", { doc: BOOK, cell: "Data!B3", text: "Is 9 right?" }),
    );
    expect(done.labeled).toBe(true);
    expect(google.sheetApi.get(BOOK)!.comments[0]).toMatchObject({
      cell: { sheetId: 0, row: 2, column: 1 },
    });
    const read = data(await c.call("carrel_read_doc", { doc: BOOK }));
    expect(read.text).toContain("## Data (0)\n1\tsite\therons\n2\tA\t4\n3\tB\t9");
    expect(read.comments[0]).toMatchObject({ quote: "Data!B3" });
    expect((await c.call("carrel_comment_doc", { doc: BOOK, text: "x" })).isError).toBe(true);
  });

  it("writes cells only on a new tab Carrel makes, raw, with a comment saying which AI made it, and never on his tabs", async () => {
    const c = await connect("owner@test.invalid", "Grok Bot");
    const edits = [
      {
        tab: "Summary",
        values: [
          ["site", "total"],
          ["A", 4],
        ],
      },
    ];
    const wrote = data(
      await c.call("carrel_change_doc", { doc: BOOK, reason: "Dustin asked for totals", edits }),
    );
    expect(wrote).toMatchObject({ edits: 1, tabs: ["Summary"], labeled: true });
    const book = google.sheetApi.get(BOOK)!;
    const made = book.tabs[1]!;
    expect(made.title).toBe("Summary");
    expect(made.rows).toEqual([
      ["site", "total"],
      ["A", "4"],
    ]);
    expect(book.writes[0]).toMatchObject({ range: "'Summary'!A1", input: "RAW" });
    expect(book.comments[0]!.posts[0]!.content).toBe(
      "Grok Bot, through Carrel: Dustin asked for totals (this tab)",
    );
    expect(await drizzle(testEnv.DB).select().from(sheetTabs).all()).toMatchObject([
      { fileId: BOOK, sheetId: made.sheetId, title: "Summary" },
    ]);
    // A later write to the tab Carrel made goes through; the read says which tabs those are.
    expect(
      (
        await c.call("carrel_change_doc", {
          doc: BOOK,
          reason: "more",
          edits: [{ tab: "summary", range: "A5", values: [["B", 9]] }],
        })
      ).isError,
    ).toBeFalsy();
    expect(data(await c.call("carrel_read_doc", { doc: BOOK })).text).toContain("## Summary (");
    expect(data(await c.call("carrel_read_doc", { doc: BOOK })).text).toContain("made by Carrel");

    const writes = book.writes.length;
    for (const args of [
      { edits: [{ tab: "Data", values: [["x"]] }] },
      { edits: [{ tab: "Data ", range: "A1", values: [["x"]] }] },
      { mode: "write", edits },
      { edits: [{ tab: "T", range: "A1:B2", values: [["x"]] }] },
      { edits: [{ tab: "T", values: [[{ not: "a cell" }]] }] },
    ])
      expect(
        (await c.call("carrel_change_doc", { doc: BOOK, reason: "r", ...args })).isError,
        JSON.stringify(args),
      ).toBe(true);
    expect(book.writes).toHaveLength(writes);
    expect(book.tabs.map((t) => t.title)).toEqual(["Data", "Summary"]);
    expect(book.tabs[0]!.rows[1]).toEqual(["A", "4"]);
  });
});

describe("the wall", () => {
  it("PLANT: Slides text is the Owner's ask; Sheets takes a tab Carrel made and comments, nothing else; no assignee", () => {
    const slides = `https://slides.googleapis.com/v1/presentations/${DECK}:batchUpdate`;
    const sheets = `https://sheets.googleapis.com/v4/spreadsheets/${BOOK}:batchUpdate`;
    const put = (range: string) =>
      `https://sheets.googleapis.com/v4/spreadsheets/${BOOK}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const text = { insertText: { objectId: "s1t", text: "x", insertionIndex: 0 } };
    const comment = { insertComment: { content: "c", objectId: "s1" } };
    const bad: [string, string, unknown, { direct?: boolean; tab?: string }?][] = [
      ["slide text", slides, { requests: [text] }],
      ["slide replace all", slides, { requests: [{ replaceAllText: {} }] }, { direct: true }],
      ["slide mixed", slides, { requests: [text, comment] }, { direct: true }],
      [
        "slide assignee",
        slides,
        { requests: [{ insertComment: { content: "c", assigneeEmailAddress: "a@example.com" } }] },
      ],
      ["sheet cells", sheets, { requests: [{ updateCells: {} }] }],
      ["sheet delete tab", sheets, { requests: [{ deleteSheet: { sheetId: 0 } }] }, { tab: "T" }],
      [
        "sheet new tab, none chosen",
        sheets,
        { requests: [{ addSheet: { properties: { title: "T" } } }] },
      ],
      [
        "sheet new tab, other title",
        sheets,
        { requests: [{ addSheet: { properties: { title: "U" } } }] },
        { tab: "T" },
      ],
      [
        "sheet assignee",
        sheets,
        { requests: [{ insertComment: { content: "c", assigneeEmailAddress: "a@example.com" } }] },
      ],
    ];
    for (const [what, url, body, opts] of bad)
      expect(() => assertAllowed("POST", url, body, opts), what).toThrow(ServiceAccountRefused);
    expect(() => assertAllowed("POST", slides, { requests: [comment] })).not.toThrow();
    expect(() =>
      assertAllowed("POST", slides, { requests: [text] }, { direct: true }),
    ).not.toThrow();
    expect(() =>
      assertAllowed(
        "POST",
        sheets,
        { requests: [{ addSheet: { properties: { title: "T" } } }] },
        { tab: "T" },
      ),
    ).not.toThrow();
    // Cells: only a range on the tab Carrel made, in the body of a PUT with valueInputOption RAW.
    expect(() => assertAllowed("PUT", put("'Data'!A1"), {}, { tab: "T" })).toThrow(
      ServiceAccountRefused,
    );
    expect(() => assertAllowed("PUT", put("'Data'!A1"), {})).toThrow(ServiceAccountRefused);
    expect(() => assertAllowed("PUT", put("'T'!A1"), {}, { tab: "T" })).not.toThrow();
    expect(() => assertAllowed("PUT", put("'It''s'!A1"), {}, { tab: "It's" })).not.toThrow();
    expect(() =>
      assertAllowed("PUT", `${put("'T'!A1").replace("RAW", "USER_ENTERED")}`, {}, { tab: "T" }),
    ).toThrow(ServiceAccountRefused);
  });
});
