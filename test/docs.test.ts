// The Docs tools (the Docs plan, slices 1 to 3): read a Doc, lay suggestions and comments in it, write directly on
// the Owner's ask, decide suggestions and take changes back, for every AI alike, against the fake Google's Docs API.
// Planted: a change to a Doc's text that is not a suggestion or marked as the Owner's ask, and a comment with an
// assignee, are refused in code before anything is sent; a Doc outside the manuscripts index, a person who is not
// the Owner, and a Doc locked against AI reach nothing.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { docActivity, saveDocsEmail, setDocLock } from "~/lib/google/docs.server";
import { refreshManuscripts } from "~/lib/google/drive.server";
import {
  clearSaTokenCache,
  assertAllowed,
  ServiceAccountRefused,
} from "~/lib/google/service-account.server";

import { addPerson, mailbox, resetDb, testEnv } from "./env";
import { fakeGoogle, serviceAccountKey } from "./google";
import { connectAs } from "./mcp-client";
import { connectedEnv, viewerFor } from "./site";

const FOLDER = "folderRoot1";
const DOC = "docTestAAAA1";
const GDOC = "application/vnd.google-apps.document";

let key: Awaited<ReturnType<typeof serviceAccountKey>>;
beforeAll(async () => {
  key = await serviceAccountKey();
});

let google: ReturnType<typeof fakeGoogle>;
let env: Env;
let box: ReturnType<typeof mailbox>;

beforeEach(async () => {
  clearSaTokenCache();
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addPerson("editor@test.invalid");
  google = fakeGoogle({
    publicJwk: key.publicJwk,
    files: [
      { id: DOC, name: "Chapter draft", mimeType: GDOC, parent: FOLDER },
      { id: "docElsewhere1", name: "Elsewhere", mimeType: GDOC, parent: "other" },
    ],
  });
  google.addDoc(DOC, {
    title: "Chapter draft",
    paragraphs: [
      { heading: 1, segs: [{ t: "Aims" }] },
      { segs: [{ t: "The river was wide and the water was cold." }] },
      {
        segs: [
          { t: "The heron stood. " },
          { t: "very quietly", ins: true },
          { t: " Then it left." },
        ],
      },
      { segs: [{ t: "Cold again. The water was cold." }] },
    ],
  });
  google.addDoc("docElsewhere1", {
    title: "Elsewhere",
    paragraphs: [{ segs: [{ t: "Not indexed." }] }],
  });
  box = mailbox();
  env = {
    ...connectedEnv(),
    EMAIL: box.EMAIL,
    GOOGLE_SA_KEY: key.json,
    GOOGLE_MANUSCRIPTS_FOLDER_ID: FOLDER,
  } as Env;
  await refreshManuscripts(env, google.fetch);
  google.requests.length = 0;
});

const connect = (email = "owner@test.invalid", client = "Claude") =>
  connectAs(email, client, { env, deps: { fetcher: google.fetch } });

/** Each call is refused, and none of them reached the Docs API. */
async function refusedUnsent(
  c: Awaited<ReturnType<typeof connect>>,
  calls: readonly (readonly [string, Record<string, unknown>])[],
) {
  for (const [tool, args] of calls)
    expect((await c.call(tool, { doc: DOC, ...args })).isError, tool).toBe(true);
  expect(google.requests.filter((r) => r.includes("docs.googleapis.com"))).toEqual([]);
}

function data(result: {
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}) {
  return result.structuredContent as unknown as {
    docs: { docId: string }[];
    title: string;
    text: string;
    tabs: { title: string }[];
    comments: { posts: unknown[] }[];
    id: string | null;
    labeled: boolean;
    labelProblem: string;
  };
}

describe("read", () => {
  it("lists the Docs in the index and reads one with its pending suggestions marked", async () => {
    const c = await connect();
    const list = await c.call("carrel_list_docs", {});
    expect(data(list).docs.map((d) => d.docId)).toEqual([DOC]);
    const read = data(await c.call("carrel_read_doc", { doc: DOC }));
    expect(read.title).toBe("Chapter draft");
    expect(read.text).toContain("The heron stood. {+very quietly+} Then it left.");
    expect(read.tabs[0]!.title).toBe("Tab 1");
    const section = data(await c.call("carrel_read_doc", { doc: DOC, heading: "Aims" }));
    expect(section.text.startsWith("Aims")).toBe(true);
  });

  it("PLANT: a Doc outside the manuscripts index, and anyone but the Owner, reach nothing", async () => {
    const owner = await connect();
    const outside = await owner.call("carrel_read_doc", { doc: "docElsewhere1" });
    expect(outside.isError).toBe(true);
    await refusedUnsent(await connect("editor@test.invalid"), [
      ["carrel_list_docs", {}],
      ["carrel_read_doc", {}],
    ]);
  });
});

describe("suggest", () => {
  it("lays edits in as suggestions, last position first, and labels each with the AI and the reason", async () => {
    const c = await connect("owner@test.invalid", "Grok Bot");
    const result = data(
      await c.call("carrel_change_doc", {
        doc: DOC,
        reason: "tighten",
        edits: [
          { find: "wide and the water was cold", replace: "wide and cold", reason: "shorter" },
          { insert_after: "Aims", text: " and approach" },
        ],
      }),
    );
    expect(result.labeled).toBe(true);
    const doc = google.docApi.get(DOC)!;
    const first = doc.batches[0] as unknown as {
      requests: {
        deleteContentRange: { range: Record<string, number> };
        insertText: { location: { index: number } };
      }[];
      writeControl: Record<string, string>;
    };
    expect(first.writeControl.writeMode).toBe("SUGGEST");
    expect(first.writeControl.requiredRevisionId).toBe("rev-1");
    // Positions: "Aims\n" is 1..6, so paragraph two starts at 6; the later paragraph's edit goes first.
    const kinds = first.requests.map((r) => Object.keys(r)[0]);
    expect(kinds).toEqual(["insertText", "deleteContentRange", "insertText"]);
    expect(first.requests[1]!.deleteContentRange.range).toMatchObject({
      startIndex: 20,
      endIndex: 47,
    });
    expect(first.requests[2]!.insertText.location.index).toBe(5);
    // The label reply names the AI and the edit's own reason.
    const labels = doc.suggestions.flatMap((s) => s.posts.map((p) => p.content));
    expect(labels).toContain("Grok Bot, through Carrel: shorter");
    expect(labels).toContain("Grok Bot, through Carrel: tighten");
    const rows = await testEnv.DB.prepare("SELECT client, mode, labeled FROM doc_changes").all();
    expect(rows.results).toEqual([{ client: "Grok Bot", mode: "suggest", labeled: 1 }]);
  });

  it("refuses a quote that is missing, ambiguous or inside a pending suggestion, and sends nothing", async () => {
    const c = await connect();
    for (const find of ["not in the doc", "was cold", "very quietly"]) {
      const result = await c.call("carrel_change_doc", {
        doc: DOC,
        reason: "r",
        edits: [{ find, replace: "x" }],
      });
      expect(result.isError, find).toBe(true);
    }
    expect(google.docApi.get(DOC)!.batches).toEqual([]);
  });

  it("says so when Google saves the suggestion but not its label, and still records the change", async () => {
    google.state.labelFails = true;
    const result = data(
      await (
        await connect()
      ).call("carrel_change_doc", {
        doc: DOC,
        reason: "r",
        edits: [{ find: "Aims", replace: "Goals" }],
      }),
    );
    expect(result.labeled).toBe(false);
    expect(result.labelProblem).toContain("labels");
    const rows = await testEnv.DB.prepare("SELECT labeled FROM doc_changes").all();
    expect(rows.results).toEqual([{ labeled: 0 }]);
  });

  it("PLANT: a direct change to a Doc's text, any other request, and a comment with an assignee are refused unsent", () => {
    const url = `https://docs.googleapis.com/v1/documents/${DOC}:batchUpdate`;
    const insert = { insertText: { text: "x", location: { index: 1 } } };
    const bad: [string, unknown][] = [
      ["direct write", { requests: [insert] }],
      ["edit mode", { requests: [insert], writeControl: { writeMode: "EDIT" } }],
      [
        "replace all",
        { requests: [{ replaceAllText: {} }], writeControl: { writeMode: "SUGGEST" } },
      ],
      ["accept", { requests: [{ acceptSuggestion: { suggestionId: "s" } }] }],
      [
        "mixed",
        {
          requests: [insert, { insertComment: { content: "c" } }],
          writeControl: { writeMode: "SUGGEST" },
        },
      ],
      [
        "assignee",
        { requests: [{ insertComment: { content: "c", assigneeEmailAddress: "a@example.com" } }] },
      ],
      [
        "reply assignee",
        {
          requests: [
            { addCommentReply: { commentId: "c", post: { assigneeEmail: "a@example.com" } } },
          ],
        },
      ],
    ];
    for (const [what, body] of bad)
      expect(() => assertAllowed("POST", url, body), what).toThrow(ServiceAccountRefused);
    expect(() =>
      assertAllowed("POST", url, { requests: [insert], writeControl: { writeMode: "SUGGEST" } }),
    ).not.toThrow();
    // The Owner's own ask lets a direct write and an accept through, and nothing wider.
    const direct = { direct: true };
    expect(() => assertAllowed("POST", url, { requests: [insert] }, direct)).not.toThrow();
    expect(() =>
      assertAllowed(
        "POST",
        url,
        { requests: [{ acceptSuggestion: { suggestionId: "s" } }] },
        direct,
      ),
    ).not.toThrow();
    for (const body of [
      { requests: [{ replaceAllText: {} }] },
      { requests: [insert, { acceptSuggestion: { suggestionId: "s" } }] },
      { requests: [insert], writeControl: { writeMode: "SUGGEST" } },
    ])
      expect(() => assertAllowed("POST", url, body, direct)).toThrow(ServiceAccountRefused);
  });
});

describe("comment", () => {
  it("comments on quoted words, replies, and resolves, each starting with the AI's name", async () => {
    const c = await connect();
    const made = data(
      await c.call("carrel_comment_doc", {
        doc: DOC,
        quote: "Cold again",
        text: "Cut this?",
        model: "Opus 5.5",
      }),
    );
    expect(made.id).toBe("c.1");
    const doc = google.docApi.get(DOC)!;
    expect(doc.comments[0]!.posts[0]!.content).toBe("Claude (Opus 5.5), through Carrel: Cut this?");
    await c.call("carrel_comment_doc", { doc: DOC, reply_to: "c.1", text: "Agreed." });
    await c.call("carrel_comment_doc", { doc: DOC, reply_to: "c.1", action: "resolve" });
    expect(doc.comments[0]!.status).toBe("RESOLVED");
    const read = data(await c.call("carrel_read_doc", { doc: DOC }));
    expect(read.comments[0]!.posts).toHaveLength(3);
    const modes = await testEnv.DB.prepare("SELECT mode FROM doc_changes ORDER BY id").all();
    expect(modes.results.map((r) => r.mode)).toEqual(["comment", "reply", "resolve"]);
  });

  it("refuses a new comment with no quote, and a comment from a person who is not the Owner", async () => {
    const result = await (await connect()).call("carrel_comment_doc", { doc: DOC, text: "x" });
    expect(result.isError).toBe(true);
    const other = await (
      await connect("editor@test.invalid")
    ).call("carrel_comment_doc", { doc: DOC, quote: "Aims", text: "x" });
    expect(other.isError).toBe(true);
    expect(google.docApi.get(DOC)!.batches).toEqual([]);
  });
});

describe("write, review, undo and locks", () => {
  const textOf = (id = DOC) =>
    google.docApi
      .get(id)!
      .paragraphs.map((p) => p.segs.map((seg) => seg.t).join(""))
      .join("\n");

  it("writes directly only when asked, emails, and undo puts the old text back", async () => {
    const c = await connect("owner@test.invalid", "Grok Bot");
    const written = data(
      await c.call("carrel_change_doc", {
        doc: DOC,
        mode: "write",
        reason: "Dustin asked for it",
        edits: [{ find: "wide and the water was cold", replace: "wide and cold" }],
      }),
    ) as unknown as { mode: string; undo: string; emailed: boolean };
    expect(written).toMatchObject({ mode: "write", emailed: true });
    expect(textOf()).toContain("The river was wide and cold.");
    const batch = google.docApi.get(DOC)!.batches[0] as { writeControl: Record<string, string> };
    expect(batch.writeControl.writeMode).toBeUndefined();
    expect(box.sent[0]!.subject).toBe('Carrel: Grok Bot wrote directly in "Chapter draft"');
    expect(box.sent[0]!.text).toContain("before: wide and the water was cold");

    const undone = data(await c.call("carrel_undo_doc", { doc: DOC, change: written.undo }));
    expect(undone).toMatchObject({ mode: "write" });
    expect(textOf()).toContain("The river was wide and the water was cold.");
    const again = await c.call("carrel_undo_doc", { doc: DOC, change: written.undo });
    expect(again.isError).toBe(true);
    const list = data(await c.call("carrel_undo_doc", { doc: DOC })) as unknown as {
      changes: { undo: string; what: string; undoneAt: string | null }[];
    };
    expect(list.changes.map((x) => [x.what, Boolean(x.undoneAt)])).toEqual([
      ["undo", false],
      ["write", true],
    ]);
  });

  it("does not undo a write whose text was edited since, and says what it was", async () => {
    await saveDocsEmail(testEnv.DB, await viewerFor("owner@test.invalid"), "off");
    const c = await connect();
    const written = data(
      await c.call("carrel_change_doc", {
        doc: DOC,
        mode: "write",
        reason: "asked",
        edits: [{ find: "Then it left", replace: "Then it flew" }],
      }),
    ) as unknown as { undo: string; emailed: string };
    expect(written.emailed).toBe("off");
    expect(box.sent).toEqual([]);
    google.docApi.get(DOC)!.paragraphs[2]!.segs = [{ t: "Rewritten by Dustin." }];
    const refused = await c.call("carrel_undo_doc", { doc: DOC, change: written.undo });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('it replaced "Then it left"');
  });

  it("accepts and rejects by id or by AI, and withdraws only the calling AI's own", async () => {
    const claude = await connect("owner@test.invalid", "Claude");
    const grok = await connect("owner@test.invalid", "Grok Bot");
    const mine = data(
      await claude.call("carrel_change_doc", {
        doc: DOC,
        reason: "r",
        edits: [{ find: "Aims", replace: "Goals" }],
      }),
    ) as unknown as { suggestionIds: string[]; undo: string };
    await grok.call("carrel_change_doc", {
      doc: DOC,
      reason: "r",
      edits: [{ find: "Cold again", replace: "Again cold" }],
    });
    const notOwn = await grok.call("carrel_review_doc", {
      doc: DOC,
      action: "withdraw",
      suggestions: mine.suggestionIds,
    });
    expect(notOwn.isError).toBe(true);
    const rejected = data(
      await claude.call("carrel_review_doc", { doc: DOC, action: "reject", by: "Grok Bot" }),
    ) as unknown as { suggestionIds: string[] };
    expect(rejected.suggestionIds).toHaveLength(2);
    const accepted = await claude.call("carrel_review_doc", {
      doc: DOC,
      action: "accept",
      suggestions: [mine.suggestionIds[0]],
    });
    expect(accepted.isError).toBeFalsy();
    const statuses = google.docApi.get(DOC)!.suggestions.map((t) => t.status);
    expect(statuses).toEqual(["ACCEPTED", "OPEN", "REJECTED", "REJECTED"]);
    // Undo of a suggestion withdraws whatever of it is still open.
    const undone = data(await claude.call("carrel_undo_doc", { doc: DOC, change: mine.undo }));
    expect(undone).toMatchObject({ mode: "withdraw", undone: [mine.suggestionIds[1]] });
  });

  it("PLANT: suggest only refuses a direct write and an accept; no AI refuses every tool; nothing is sent", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const c = await connect();
    await setDocLock(testEnv.DB, owner, DOC, "suggest-only");
    await refusedUnsent(c, [
      [
        "carrel_change_doc",
        { mode: "write", reason: "r", edits: [{ find: "Aims", replace: "Goals" }] },
      ],
      ["carrel_review_doc", { action: "accept", suggestions: ["suggest.pending"] }],
    ]);
    await setDocLock(testEnv.DB, owner, DOC, "no-ai");
    await refusedUnsent(c, [
      ["carrel_read_doc", {}],
      ["carrel_change_doc", { reason: "r", edits: [{ find: "Aims", replace: "Goals" }] }],
      ["carrel_comment_doc", { quote: "Aims", text: "x" }],
      ["carrel_undo_doc", {}],
    ]);
  });
});

describe("Docs activity", () => {
  it("lists what each AI did in which Doc, newest first, to the Owner alone", async () => {
    const c = await connect();
    await c.call("carrel_change_doc", {
      doc: DOC,
      reason: "r",
      edits: [{ find: "Aims", replace: "Goals" }],
    });
    await (
      await connect("owner@test.invalid", "Grok Bot")
    ).call("carrel_comment_doc", {
      doc: DOC,
      quote: "Cold again",
      text: "Cut?",
    });
    const rows = await docActivity(env, await viewerFor("owner@test.invalid"));
    expect(rows.map((r) => [r.client, r.mode, r.name])).toEqual([
      ["Grok Bot", "comment", "Chapter draft"],
      ["Claude", "suggest", "Chapter draft"],
    ]);
    await expect(docActivity(env, await viewerFor("editor@test.invalid"))).rejects.toMatchObject({
      status: 404,
    });
  });
});
