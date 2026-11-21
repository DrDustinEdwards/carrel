// The Docs tools: read a Doc, lay suggestions and comments in it, write directly on
// the Owner's ask, decide suggestions and take changes back, for every AI alike, against the fake Google's Docs API.
// Planted: a change to a Doc's text that is not a suggestion or marked as the Owner's ask, and a comment with an
// assignee, are refused in code before anything is sent; a Doc outside the manuscripts index, a person who is not
// the Owner, and a Doc locked against AI reach nothing.

import { beforeEach, describe, expect, it } from "vitest";

import { base64url } from "@dustinedwards/site-runtime/encoding";

import { docActivity, saveDocsEmail, setDocLock } from "~/lib/google/docs.server";
import { refreshManuscripts } from "~/lib/google/drive.server";
import { panelAnswer } from "~/lib/google/panel.server";
import { driveNotice, keepWatching } from "~/lib/google/watch.server";
import { needsYou } from "~/lib/desk.server";
import { visibleProjects } from "~/lib/people.server";
import { assertAllowed, ServiceAccountRefused } from "~/lib/google/service-account.server";

import { mailbox, testEnv } from "./env";
import { type fakeGoogle, rsaPair } from "./google";
import { connectAs } from "./mcp-client";
import { googleDesk, viewerFor } from "./site";

const FOLDER = "folderRoot1";
const DOC = "docTestAAAA1";
const GDOC = "application/vnd.google-apps.document";

let google: ReturnType<typeof fakeGoogle>;
let env: Env;
let box: ReturnType<typeof mailbox>;

beforeEach(async () => {
  ({ google, env, box } = await googleDesk(
    FOLDER,
    [
      { id: DOC, name: "Chapter draft", mimeType: GDOC, parent: FOLDER },
      { id: "docElsewhere1", name: "Elsewhere", mimeType: GDOC, parent: "other" },
    ],
    (g) => {
      g.addDoc(DOC, {
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
      g.addDoc("docElsewhere1", {
        title: "Elsewhere",
        paragraphs: [{ segs: [{ t: "Not indexed." }] }],
      });
    },
  ));
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

describe("export", () => {
  it("exports a Doc in the index as text here, and as a Desk download link for Word and PDF", async () => {
    const c = await connect();
    const md = (await c.call("carrel_export_doc", { doc: DOC, format: "md" }))
      .structuredContent as {
      text: string;
    };
    expect(md.text).toContain("The river was wide and the water was cold.");
    const word = (await c.call("carrel_export_doc", { doc: DOC, format: "docx" }))
      .structuredContent as { url: string };
    expect(word.url).toMatch(new RegExp(`/manuscripts/${DOC}/export/docx$`));
    const outside = await c.call("carrel_export_doc", { doc: "docElsewhere1", format: "md" });
    expect(outside.isError).toBe(true);
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

describe("Carrel writes it", () => {
  /** The model's answer, then Google: what Carrel's own engine would write for the request. */
  function modelFetcher(answer: unknown) {
    const asked: Record<string, unknown>[] = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url !== "https://api.anthropic.com/v1/messages") return google.fetch(input, init);
      asked.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(answer) }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    };
    return { fetcher: fetcher as typeof fetch, asked };
  }

  function withModel(answer: unknown) {
    const { fetcher, asked } = modelFetcher(answer);
    const c = connectAs("owner@test.invalid", "Grok Bot", {
      env: { ...env, ANTHROPIC_API_KEY: "sk-ant-api-test" } as Env,
      deps: { fetcher },
    });
    return { c, asked };
  }

  it("writes the edits with Carrel's own model and effort, labels them as Carrel's for the AI that asked, and skips a quote it cannot place", async () => {
    const { c: client, asked } = withModel({
      edits: [
        {
          kind: "replace",
          quote: "wide and the water was cold",
          text: "wide and cold",
          reason: "shorter",
        },
        { kind: "replace", quote: "not in the Doc", text: "x", reason: "made up" },
      ],
      note: "One cut.",
    });
    const c = await client;
    const result = (
      await c.call("carrel_change_doc", {
        doc: DOC,
        reason: "tighten",
        ask: "Tighten the river sentence.",
      })
    ).structuredContent as {
      engine: string;
      model: string;
      skipped: { quote: string }[];
      suggestionIds: string[];
    };
    expect(result).toMatchObject({ engine: "api", model: "claude-opus-5-5" });
    expect(result.skipped.map((s) => s.quote)).toEqual(["not in the Doc"]);
    expect(asked[0]).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "medium" },
    });
    const labels = google.docApi
      .get(DOC)!
      .suggestions.flatMap((s) => s.posts.map((p) => p.content));
    expect(labels).toContain(
      "Carrel (Claude API) for Grok Bot (claude-opus-5-5), through Carrel: shorter",
    );
    const usage = await testEnv.DB.prepare("SELECT feature, effort FROM ai_usage").all();
    expect(usage.results).toEqual([{ feature: "docs-edit", effort: "medium" }]);
  });

  it("the Docs panel: Google's ID token for the add-on's client, naming the Owner, runs the job with his selection; any other token reaches nothing", async () => {
    const pair = await rsaPair();
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "google-kid" };
    const keys = async (kid: string) => (kid === "google-kid" ? jwk : undefined);
    const now = Math.floor(Date.now() / 1000);
    const sign = async (claims: Record<string, unknown>) => {
      const head = base64url(
        new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "google-kid" })),
      );
      const body = base64url(
        new TextEncoder().encode(
          JSON.stringify({
            iss: "https://accounts.google.com",
            aud: "panel.apps.googleusercontent.com",
            email: "owner@test.invalid",
            email_verified: true,
            iat: now,
            exp: now + 3600,
            ...claims,
          }),
        ),
      );
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`),
      );
      return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
    };
    const { fetcher, asked } = modelFetcher({
      edits: [
        {
          kind: "replace",
          quote: "wide and the water was cold",
          text: "wide and cold",
          reason: "shorter",
        },
      ],
      note: "One cut.",
    });
    const panelEnv = {
      ...env,
      ANTHROPIC_API_KEY: "sk-ant-api-test",
      GOOGLE_PANEL_CLIENT_ID: "panel.apps.googleusercontent.com",
    } as Env;
    const ask = async (claims: Record<string, unknown>) =>
      panelAnswer(
        new Request("https://carrel-mcp.test/docs-panel", {
          method: "POST",
          headers: { Authorization: `Bearer ${await sign(claims)}` },
          body: JSON.stringify({
            doc: DOC,
            ask: "Tighten this.",
            job: "edit",
            selection: "The river was wide",
          }),
        }),
        panelEnv,
        keys,
        fetcher,
      );

    const editor = await ask({ email: "editor@test.invalid" });
    expect(editor.status).toBe(403);
    const unverified = await ask({ email_verified: false });
    expect(unverified.status).toBe(403);
    const other = await ask({ aud: "other.apps.googleusercontent.com" });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain(
      "other.apps.googleusercontent.com",
    );
    expect(asked).toEqual([]);

    const done = await ask({});
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, model: "claude-opus-5-5" });
    expect(JSON.stringify(asked[0])).toContain("The river was wide");
    const rows = await testEnv.DB.prepare("SELECT client FROM doc_changes").all();
    expect(rows.results).toEqual([{ client: "Carrel (Claude API) for Docs panel" }]);
  });

  it("PLANT: a locked Doc refuses before the model is asked", async () => {
    await setDocLock(testEnv.DB, await viewerFor("owner@test.invalid"), DOC, "no-ai");
    const { c: client, asked } = withModel({ comments: [], note: "" });
    const c = await client;
    const refused = await c.call("carrel_comment_doc", { doc: DOC, ask: "Review it." });
    expect(refused.isError).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("awareness", () => {
  it("counts the AI suggestions still open in a Doc that changed, lists them on the Owner's Home, and refreshes on Google's notice from its own channel only", async () => {
    const c = await connect("owner@test.invalid", "Grok Bot");
    await c.call("carrel_change_doc", {
      doc: DOC,
      reason: "tighten",
      edits: [{ find: "wide and the water was cold", replace: "wide and cold", reason: "shorter" }],
    });
    google.files.find((f) => f.id === DOC)!.modifiedTime = "2026-11-17T10:00:00.000Z";
    await refreshManuscripts(env, google.fetch);
    const owner = await viewerFor("owner@test.invalid");
    const visible = await visibleProjects(testEnv.DB, owner);
    const needs = await needsYou(testEnv.DB, owner, visible);
    expect(needs.find((n) => n.id === `doc-${DOC}`)).toMatchObject({
      group: "ai",
      title: "2 AI suggestions wait in a Doc",
      detail: "Chapter draft",
    });

    // The channel opens once, and a day before its week is up a new one replaces it.
    const now = new Date("2026-11-17T12:00:00.000Z");
    expect(await keepWatching(env, google.fetch, now)).toBe("renewed");
    expect(await keepWatching(env, google.fetch, now)).toBe("watching");
    expect(await keepWatching(env, google.fetch, new Date(now.getTime() + 6.5 * 86_400_000))).toBe(
      "renewed",
    );
    expect(google.state.channels.map((ch) => ch.path)).toEqual([
      "/drive/v3/changes/watch",
      "/drive/v3/changes/watch",
      "/drive/v3/channels/stop",
    ]);
    const open = google.state.channels[1]!;
    expect(open).toMatchObject({
      type: "web_hook",
      address: expect.stringMatching(/\/drive-changes$/),
    });

    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    } as unknown as ExecutionContext;
    const notice = (id: unknown, token: unknown) =>
      driveNotice(
        new Request("https://carrel-mcp.test/drive-changes", {
          method: "POST",
          headers: {
            "X-Goog-Channel-ID": String(id),
            "X-Goog-Channel-Token": String(token),
            "X-Goog-Resource-State": "change",
          },
        }),
        env,
        ctx,
        google.fetch,
      );
    expect(
      (await notice(google.state.channels[0]!.id, google.state.channels[0]!.token)).status,
    ).toBe(404);
    expect((await notice(open.id, "guessed")).status).toBe(404);
    expect(waits).toHaveLength(0);
    expect((await notice(open.id, open.token)).status).toBe(200);
    expect((await notice(open.id, open.token)).status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
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
