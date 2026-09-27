// The MCP endpoint and its tools, as an AI client meets them: sessions, the tools over posts, and the
// planted refusals from design decision 2 (a shared user's session publishing, a reviewer
// publishing, an Owner's publish with an open flag). The site is site-api's own handler over its
// reference adapter; the email binding is a mailbox the tests read.

import { beforeEach, describe, expect, it } from "vitest";

import { autosave, readDraft } from "~/lib/content.server";
import { runHealth } from "~/lib/health.server";
import { handleMcp } from "~/lib/mcp/server";
import { requireSiteProject } from "~/lib/projects.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
const CARREL = "https://carrel.test";

type Sent = { from: string; to: string; subject: string; text: string };

function mailbox(fail = false) {
  const sent: Sent[] = [];
  const EMAIL = {
    async send(message: Sent) {
      if (fail) throw new Error("send failed");
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, EMAIL };
}

let site: ReturnType<typeof fakeSite>;
let box: ReturnType<typeof mailbox>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
  await addPerson("stranger@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  await share(id, reviewer, "reader");
  site = fakeSite();
  box = mailbox();
  env = { ...connectedEnv(), EMAIL: box.EMAIL };
});

async function post(email: string, body: unknown, session?: string, headers: Record<string, string> = {}, e: Env = env) {
  const request = new Request(`${CARREL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return handleMcp(request, e, await viewerFor(email), { fetcher: site.fetch, carrelOrigin: CARREL });
}

async function connect(email: string, clientName = "Claude") {
  const response = await post(email, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0" } },
  });
  const session = response.headers.get("Mcp-Session-Id")!;
  expect((await post(email, { jsonrpc: "2.0", method: "notifications/initialized" }, session)).status).toBe(202);
  return {
    session,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await post(email, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, session);
      const body = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } };
      return body.result;
    },
  };
}

/** A post the Owner saved on the site through the buttons' own function, returned with its version. */
async function seedPost(status: "draft" | "published" = "draft") {
  const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nDustin's words.\n", expectedVersion: null, changeId: "seed" });
  if (status === "draft") return saved.version;
  return (await site.adapter.content.publish("post-one", { expectedVersion: saved.version, changeId: "seed-publish" })).version;
}

describe("the MCP session", () => {
  it("negotiates the protocol, names the client, and lists the tools", async () => {
    const response = await post("owner@test.invalid", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Claude", version: "1.0" } },
    });
    const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown } };
    expect(body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "carrel" }, capabilities: { tools: {} } });
    const session = response.headers.get("Mcp-Session-Id");
    expect(session).toMatch(/^[0-9a-f-]{36}$/);

    const list = (await (await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "tools/list" }, session!)).json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(["list_projects", "search_items", "read_item", "save_draft", "preview", "get_checks", "add_finding", "publish", "list_book_files", "read_book_file", "check_book_text", "save_book_draft", "add_book_finding", "draft_social_post"]);
    for (const tool of list.result.tools) expect(tool.description).toContain("AI never rewrites Dustin's prose unasked.");
  });

  it("answers an unknown protocol version with the latest it speaks", async () => {
    const response = await post("owner@test.invalid", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", clientInfo: { name: "x" } } });
    expect(((await response.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
  });

  it("PLANT: a call with no session, or someone else's session, is refused", async () => {
    expect((await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(400);
    const { session } = await connect("editor@test.invalid");
    expect((await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "tools/list" }, session)).status).toBe(404);
  });

  it("PLANT: a page elsewhere cannot drive the tools, and GET, batches and bad JSON are refused", async () => {
    const { session } = await connect("owner@test.invalid");
    expect((await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "tools/list" }, session, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await handleMcp(new Request(`${CARREL}/mcp`), env, await viewerFor("owner@test.invalid"))).status).toBe(405);
    expect((await post("owner@test.invalid", [{ jsonrpc: "2.0", id: 1, method: "ping" }], session)).status).toBe(400);
    const bad = new Request(`${CARREL}/mcp`, { method: "POST", body: "{not json", headers: { "Mcp-Session-Id": session } });
    expect((await handleMcp(bad, env, await viewerFor("owner@test.invalid"))).status).toBe(400);
  });

  it("ends a session on DELETE", async () => {
    const { session } = await connect("owner@test.invalid");
    const del = new Request(`${CARREL}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": session } });
    expect((await handleMcp(del, env, await viewerFor("owner@test.invalid"))).status).toBe(204);
    expect((await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "ping" }, session)).status).toBe(404);
  });
});

describe("reading, drafting, flagging", () => {
  it("lists projects, searches and reads posts through the buttons' own functions", async () => {
    await seedPost();
    const ai = await connect("reader@test.invalid");
    expect((await ai.call("list_projects")).structuredContent).toMatchObject({ projects: [{ slug: SLUG, role: "reader" }] });
    const read = await ai.call("read_item", { project: SLUG, item: "post-one" });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ site: { id: "post-one", title: "Post one" }, dustinsDraft: null, aiDrafts: [], flags: [] });
  });

  it("PLANT: a stranger's session reads nothing", async () => {
    const ai = await connect("stranger@test.invalid");
    const result = await ai.call("read_item", { project: SLUG, item: "post-one" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Not found, or not shared with this person." }] });
  });

  it("saves an AI draft beside Dustin's, never over his draft or the site's text", async () => {
    const version = await seedPost();
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(testEnv.DB, owner, SLUG, "read");
    await autosave(testEnv.DB, project, owner, "post-one", { source: "Dustin's working draft.", baseVersion: version });

    const ai = await connect("owner@test.invalid");
    const saved = await ai.call("save_draft", { project: SLUG, item: "post-one", source: "An AI rewrite.", note: "Tightened the opening." });
    expect(saved.structuredContent).toMatchObject({ saved: true, basedOnVersion: version });
    expect((await readDraft(testEnv.DB, project, owner, "post-one"))?.source).toBe("Dustin's working draft.");
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nDustin's words.\n");
    expect(site.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    const read = await ai.call("read_item", { project: SLUG, item: "post-one" });
    expect(read.structuredContent).toMatchObject({ aiDrafts: [{ client: "Claude 1.0", note: "Tightened the opening." }] });
  });

  it("PLANT: a Reader's session and a reviewer's cannot save a draft", async () => {
    await seedPost();
    expect(await (await connect("reader@test.invalid")).call("save_draft", { project: SLUG, item: "post-one", source: "x" })).toMatchObject({
      isError: true,
      content: [{ text: "You may not write drafts on this project." }],
    });
    expect(await (await connect("reviewer@test.invalid")).call("save_draft", { project: SLUG, item: "post-one", source: "x" })).toMatchObject({
      isError: true,
      content: [{ text: "A reviewer flags; it does not write text. Use add_finding." }],
    });
  });

  it("lets a reviewer flag, once per flag, credited to its client", async () => {
    await seedPost();
    const reviewer = await connect("reviewer@test.invalid", "Grok Build");
    const args = { project: SLUG, item: "post-one", message: "This number has no source.", excerpt: "Dustin's words." };
    expect((await reviewer.call("add_finding", args)).structuredContent).toMatchObject({ flagged: true, alreadyFlagged: false });
    expect((await reviewer.call("add_finding", args)).structuredContent).toMatchObject({ alreadyFlagged: true });
    const checks = await (await connect("owner@test.invalid")).call("get_checks", { project: SLUG, item: "post-one" });
    expect(checks.structuredContent).toMatchObject({ open: 1, flags: [{ check: "review", message: "This number has no source. (from Grok Build 1.0)" }] });
  });

  it("previews through the site's own renderer", async () => {
    await seedPost();
    const result = await (await connect("reader@test.invalid")).call("preview", { project: SLUG, item: "post-one", source: "---\ntitle: T\n---\nHello." });
    expect(result.isError).toBeUndefined();
    expect(String(result.structuredContent?.html)).toContain("Hello.");
  });
});

describe("publish by instruction (decision 2)", () => {
  it("PLANT: a shared user's session publishing is refused, and the site and inbox hear nothing", async () => {
    const version = await seedPost();
    const result = await (await connect("editor@test.invalid")).call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Only the Owner's own sessions may publish." }] });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
    expect(site.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect(box.sent).toEqual([]);
  });

  it("PLANT: a reviewer publishing is refused", async () => {
    const version = await seedPost();
    const result = await (await connect("reviewer@test.invalid")).call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect(result).toMatchObject({ isError: true, content: [{ text: "A reviewer never publishes." }] });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("PLANT: the Owner's AI publish with an open flag is refused, naming the flag", async () => {
    const version = await seedPost();
    await (await connect("reviewer@test.invalid", "Grok Build")).call("add_finding", { project: SLUG, item: "post-one", message: "Unsourced claim." });
    const result = await (await connect("owner@test.invalid")).call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Publish is refused while 1 flag is open on this post: Unsourced claim. (from Grok Build 1.0) Dustin fixes the text or dismisses each flag in Carrel first.",
    );
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
    expect(box.sent).toEqual([]);
  });

  it("the Owner's AI publish with clean checks publishes, credits the client, and emails Dustin an unpublish link", async () => {
    const version = await seedPost();
    const result = await (await connect("owner@test.invalid", "Claude")).call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect(result.structuredContent).toMatchObject({ published: true, dustinEmailed: true });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");

    const change = await testEnv.DB.prepare("SELECT action, client FROM changes WHERE item_id = 'post-one'").first();
    expect(change).toEqual({ action: "publish", client: "Claude 1.0" });
    const record = await testEnv.DB.prepare("SELECT client, emailed_at, email_error FROM ai_publications").first<{ client: string; emailed_at: string | null; email_error: string | null }>();
    expect(record).toMatchObject({ client: "Claude 1.0", email_error: null });
    expect(record!.emailed_at).not.toBeNull();

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ to: "owner@test.invalid", subject: 'Carrel: Claude 1.0 published "Post one"' });
    expect(box.sent[0]!.text).toContain("Published by Claude 1.0 on Dustin's instruction.");
    expect(box.sent[0]!.text).toContain(`Unpublish it: ${CARREL}/p/${SLUG}/e/post-one/unpublish`);
  });

  it("PLANT: publish sends no text, so an AI draft can never be what goes live", async () => {
    const version = await seedPost();
    const ai = await connect("owner@test.invalid");
    await ai.call("save_draft", { project: SLUG, item: "post-one", source: "---\ntitle: Post one\n---\nAI words.\n" });
    await ai.call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nDustin's words.\n");
  });

  it("PLANT: a stale expected version is refused by the site", async () => {
    await seedPost();
    const result = await (await connect("owner@test.invalid")).call("publish", { project: SLUG, item: "post-one", expected_version: "stale" });
    expect(result.isError).toBe(true);
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("keeps the publish when the email fails, records why, and the health check reports it", async () => {
    const version = await seedPost();
    const failing = mailbox(true);
    const e = { ...env, EMAIL: failing.EMAIL };
    const response = await post("owner@test.invalid", { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "Claude" } } }, undefined, {}, e);
    const session = response.headers.get("Mcp-Session-Id")!;
    const call = await post("owner@test.invalid", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "publish", arguments: { project: SLUG, item: "post-one", expected_version: version } } }, session, {}, e);
    expect(((await call.json()) as { result: { structuredContent: unknown } }).result.structuredContent).toMatchObject({ published: true, dustinEmailed: false });

    const health = mailbox();
    const { results } = await runHealth({ ...testEnv, EMAIL: health.EMAIL }, async () => Response.json({ keys: [{ kid: "k" }] }));
    expect(results.find((r) => r.name === "ai-publish-email")).toMatchObject({ ok: false, detail: "1 AI publish was not emailed: post-one by Claude (send failed)." });
  });
});
